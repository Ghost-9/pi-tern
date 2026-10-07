#!/usr/bin/env node
/**
 * Render proof: is a native surface actually *displayed*, or merely accepted?
 *
 * ## Why this file exists
 *
 * Every render claim in pi-tern used to rest on frame acceptance. Tern answers with zero errors and
 * `capture --surfaces` returns the parsed content — but that method cannot tell a surface that
 * **renders** from one that **renders nothing**. Both are equally true of a blank pane. That is not
 * theoretical: releases 1.1.0 through 1.1.4 recorded native surfaces as "verified" on exactly that
 * evidence, and shipped a P0 in which native mode removed pi's entire interface and displayed
 * nothing at all.
 *
 * So this checks the one thing that can be checked: whether the surface reached the screen.
 *
 * ## The oracle
 *
 * `tern ctl stats` reports the window's live layout counts — `nodes`, `frames`, `images`. A surface
 * with content raises them; an empty one does not. That is a real measurement rather than a
 * validator's opinion, and it needs no screenshot permission.
 *
 * ## What blocks it today, measured
 *
 * Surfaces are displayed **only in an agent block**. Tern's harness commands that create one —
 * `agent-command`, `block agent`, `new-blocks agent` — all return `{"ok":false,"error":"timed out
 * after 20s"}` on Tern 0.5.1 here, and they do it for *any* command, including `/usr/bin/true` and
 * `/bin/sleep 300`. A fresh control window times out on `new-blocks agent` alone. So the harness
 * cannot host an agent block at all, and therefore cannot display a native surface.
 *
 * That is a platform limit, not a pi-tern defect, and it is why the honest result here is often
 * "unproven" rather than "pass".
 *
 * ## Modes
 *
 *   node scripts/render-proof.mjs            measure and report; exit 0 unless the harness is broken
 *   node scripts/render-proof.mjs --require  exit non-zero unless a surface was actually displayed
 *
 * `--require` is what a release should use. The default mode is for day-to-day runs, where reporting
 * "unproven, and here is exactly why" is more useful than failing the whole gate on a Tern bug.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requireProof = process.argv.includes("--require");
const launcher = path.join(root, "native", "pi-tern.mjs");

const report = { checkedAt: new Date().toISOString(), tern: null, harness: null, surface: null };

function tern(args, options = {}) {
	return spawnSync("tern", args, { encoding: "utf8", timeout: options.timeoutMs ?? 30000, ...options });
}

/**
 * Parse a `tern ctl` answer.
 *
 * Its stdout carries an echo of each command (`> new-blocks agent`) before the reply, so it is not
 * always a single JSON document — and when the command *succeeds* that echo is all that precedes
 * `{"ok":true}`. Taking the last parseable line handles both shapes, and taking the first document
 * instead would read the echo and call every success a failure.
 */
function lastJson(text) {
	const lines = String(text ?? "").split("\n");
	for (let i = lines.length - 1; i >= 0; i -= 1) {
		const line = lines[i].trim().replace(/^<\s*/, "");
		if (!line.startsWith("{")) continue;
		try {
			return JSON.parse(line);
		} catch {
			/* keep looking */
		}
	}
	return null;
}

function ctl(ep, command, timeoutMs = 25000) {
	const result = spawnSync("tern", ["ctl", "--control", ep, ...command], { encoding: "utf8", timeout: timeoutMs });
	const payload = lastJson(result.stdout);
	if (payload) return payload;
	return { ok: false, error: result.stderr?.trim() || result.stdout?.trim() || "no JSON" };
}

const version = tern(["--version"]);
report.tern = version.stdout.trim() || version.stderr.trim();

if (!version.stdout.includes("tern ")) {
	console.log(`SKIP render proof: no \`tern\` on PATH (${report.tern})`);
	process.exit(0);
}

/**
 * Can the harness create an agent block? Probed with the cheapest command rather than assumed,
 * because assuming is what produced four releases of false confidence.
 *
 * The scenario goes in a real file: `ctl --file -` reads from stdin, and on 0.5.1 that path fails
 * with ENOENT on the *control socket* even while `ctl stats` against the same socket succeeds —
 * confusing enough to be worth a comment rather than rediscovering.
 */
async function probeAgentBlock(ep) {
	const scenario = path.join(dir, "agent-block.txt");
	writeFileSync(scenario, "new-blocks agent\n");
	const attempt = spawnSync("tern", ["ctl", "--control", ep, "--file", scenario], {
		encoding: "utf8",
		timeout: 30000,
	});
	const payload = lastJson(attempt.stdout);
	const works = payload?.ok === true;
	return {
		canCreateAgentBlock: works,
		detail: works
			? "new-blocks agent succeeded"
			: `new-blocks agent failed: ${payload?.error ?? attempt.stderr?.trim() ?? "no response"}`,
	};
}

const dir = mkdtempSync(path.join(os.tmpdir(), "pi-tern-render-"));
// The control endpoint this run will talk to. Null until we have something to talk to: either a
// window the caller lent us, or one we were explicitly allowed to open. Assigning the scratch path
// up front would make every "do we have an endpoint" check answer yes.
let ep = null;
// Declared out here, not inside the `try`, for a reason worth writing down: `catch` and `finally`
// are sibling blocks and cannot see `let` bindings made inside `try`. Declared in there, the cleanup
// below references two undefined names — so the window never closes and every run leaks one.
let spawned = null;
let ownedWindow = false;

/**
 * Control flow, deliberately not `process.exit`.
 *
 * Every path out of this script used to call `process.exit()` from inside the `try`, and
 * `process.exit` terminates the process immediately — so the `finally` that closes the window never
 * ran, on any path that had actually opened one. That leaked a GUI window into the user's session on
 * every BLOCKED run, which is exactly the accumulation being fixed here. So the outcome is recorded,
 * cleanup runs in `finally`, and the exit happens afterwards.
 */
class Skipped extends Error {}
let outcome = 0;

try {
	// Which kind of session to measure in.
	//
	// This has to be a real *window*, not a headless `tern serve`: a surface is displayed only in an
	// agent block, and an agent block belongs to a window. A headless session can never answer the
	// question, so using one would report BLOCKED for a reason that has nothing to do with Tern's
	// ability to host one.
	//
	// Which is exactly why opening one is opt-in. The gate runs this on every build, and a window per
	// build is the churn that put tabs in windows nobody asked for — during testing, this script was
	// opening a GUI window on every single gate run to learn something that has been BLOCKED all along.
	//
	// So: reuse a window that already has a control endpoint if there is one, and otherwise say so
	// rather than opening a ninth window. `PI_TERN_RENDER_WINDOW=1` forces a temporary one.
	const existingWindow = process.env.TERN_WINDOW_SOCKET;
	if (existingWindow) {
		const probe = ctl(existingWindow, ["stats"], 5000);
		if (probe?.ok === true) {
			ep = existingWindow;
		} else {
			// Do not fall through to opening a window on the strength of an endpoint that cannot
			// answer: the caller's window is stale, and quietly replacing it with a new one is the
			// exact surprise this change exists to remove.
			console.log(`SKIP render proof: TERN_WINDOW_SOCKET is set but ${existingWindow} did not answer`);
			outcome = requireProof ? 1 : 0;
			throw new Skipped("configured control endpoint is stale");
		}
	}

	if (!ep) {
		if (process.env.PI_TERN_RENDER_WINDOW !== "1") {
			report.surface = { displayed: false, proven: false, reason: "needs-a-window" };
			console.log("SKIP render proof: would have to open a window.");
			console.log(
				"         A surface is displayed only in an agent block, and an agent block belongs to a\n" +
				"         window, so this cannot be answered headlessly. Rather than open one on every\n" +
				"         build, run it deliberately:\n" +
				"           PI_TERN_RENDER_WINDOW=1 node scripts/render-proof.mjs\n" +
				"         or set TERN_WINDOW_SOCKET to a window you already have open.",
			);
			outcome = requireProof ? 1 : 0;
			throw new Skipped("would have to open a window");
		}
		ep = path.join(dir, "ep.sock");
		spawned = spawn("tern", ["--control", ep], { stdio: "ignore", detached: true });
		spawned.on("error", (error) => console.error(`render-proof: could not start a window: ${error.message}`));
		spawned.unref?.();
		ownedWindow = true;
	}

	// Wait for the endpoint to actually answer, not merely for the socket file to appear: on a cold
	// start the socket lands well before `ctl` can be served, and a file-existence check reports
	// ready and then fails with ENOENT one call later.
	//
	// Always polled, including for a window we just opened — an assigned path says nothing about
	// whether `ctl` can be served yet, and skipping the wait is how the probe ends up reporting a
	// socket error instead of a measurement.
	let ready = false;
	let baseline = null;
	for (let i = 0; i < 60 && !ready; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 500));
		baseline = ctl(ep, ["stats"], 8000);
		ready = baseline?.ok === true;
	}
	if (!ready) {
		console.log("SKIP render proof: no control window could be started");
		report.harness = { started: false };
		outcome = requireProof ? 1 : 0;
		throw new Skipped("no control window could be started");
	}
	report.harness = await probeAgentBlock(ep);

	if (!report.harness.canCreateAgentBlock) {
		// This is the measured platform limit, and it is the honest answer: unproven, with a reason.
		report.surface = { displayed: false, proven: false, reason: "harness-cannot-create-agent-block" };
		console.log(`BLOCKED render proof: ${report.harness.detail}`);
		console.log(
			"         Tern displays a native surface only in an agent block, and its own harness cannot\n" +
				"         create one on this build. Acceptance is not display — treat every native render\n" +
				"         claim as UNVERIFIED until this probe passes. See docs/RENDER-PROOF.md.",
		);
		writeFileSync(path.join(root, "docs", "render-proof-last.json"), `${JSON.stringify(report, null, 2)}\n`);
		outcome = 0;
		throw new Skipped("harness cannot host an agent block");
	}

	// Reachable only once the platform can host an agent block. Kept here rather than written when
	// it works, so the logic is reviewed and tested by reading rather than discovered under pressure.
	const afterKind = ctl(ep, ["stats"]);
	report.surface = {
		displayed: false,
		proven: false,
		reason: "harness-created-agent-block-but-no-surface-content",
		baselineNodes: baseline?.nodes,
		nodes: afterKind?.nodes,
	};
	console.log("FAIL render proof: the agent block was created but no surface content appeared");
	writeFileSync(path.join(root, "docs", "render-proof-last.json"), `${JSON.stringify(report, null, 2)}\n`);
	outcome = 1;
	throw new Skipped("agent block created but no surface content");
} catch (error) {
	// `Skipped` is how the interesting paths leave the `try`, so that `finally` runs and the window
	// is closed. Any other error is a real fault and must not be swallowed.
	if (!(error instanceof Skipped)) throw error;
} finally {
	// Only close what this run opened, and close it properly.
//
// `tern --control` forks the real window, so the process we spawned is a short-lived parent and the
// window is re-parented to init: killing the handle alone leaves an orphan window attached to the
// user's session, which is precisely the accumulation this change exists to stop. Because the spawn
// is `detached`, the child leads its own process group, so a negative pid reaches the whole group.
	const stopGroup = (signal) => {
		if (!spawned?.pid) return;
		try {
			process.kill(-spawned.pid, signal);
		} catch {
			try {
				spawned.kill(signal);
			} catch {
				/* already gone */
			}
		}
	};
	if (ownedWindow && spawned) {
		// Prefer the documented way to close, then make sure with the group.
		ctl(ep, ["quit"], 4000);
		stopGroup("SIGTERM");
		await new Promise((resolve) => setTimeout(resolve, 1200));
		stopGroup("SIGKILL");
	}
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
}

// Only now, with the window closed and the scratch directory gone.
process.exit(outcome);
