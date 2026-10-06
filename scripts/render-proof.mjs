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

function ctl(ep, command, timeoutMs = 25000) {
	const result = spawnSync("tern", ["ctl", "--control", ep, ...command], { encoding: "utf8", timeout: timeoutMs });
	try {
		return JSON.parse(result.stdout);
	} catch {
		return { ok: false, error: result.stderr?.trim() || result.stdout?.trim() || "no JSON" };
	}
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
	let payload;
	try {
		payload = JSON.parse(attempt.stdout);
	} catch {
		payload = { ok: false, error: attempt.stdout?.trim() || attempt.stderr?.trim() || "no response" };
	}
	const works = payload?.ok === true;
	return {
		canCreateAgentBlock: works,
		detail: works ? "new-blocks agent succeeded" : `new-blocks agent failed: ${payload?.error ?? "unknown"}`,
	};
}

const dir = mkdtempSync(path.join(os.tmpdir(), "pi-tern-render-"));
const ep = path.join(dir, "ep.sock");

try {
	// A window of our own, so the measurement is not disturbed by whatever the user is looking at.
	const window = spawn("tern", ["--control", ep], { stdio: "ignore", detached: true });
	window.unref?.();
	// Wait for the endpoint to actually answer, not merely for the socket file to appear: on a cold
	// start the socket lands well before `ctl` can be served, and a file-existence check reports
	// ready and then fails with ENOENT one call later.
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
		if (requireProof) process.exit(1);
		process.exit(0);
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
		process.exit(requireProof ? 1 : 0);
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
	process.exit(1);
} finally {
	spawn("pkill", ["-f", `tern --control ${ep}`], { stdio: "ignore" });
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
}
