#!/usr/bin/env node
/**
 * pi-tern launcher: probes Tern for TSP support, then runs pi through the
 * unbundled entry with the native loader hook. Falls back to the stock pi
 * launcher whenever anything is missing or Tern does not answer.
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { clearProbeFailure, probe, recordProbeFailure } from "./handshake.mjs";

/**
 * Report a launcher failure on stderr and exit non-zero.
 *
 * This exists because the launcher used to spawn a bare "pi" with no `error` handler: on a machine
 * with no pi on PATH the spawn failed, the exit event never carried the failure, and the launcher
 * exited 0 having printed nothing. A component whose entire job is to be invisible must still be
 * honest when it cannot start anything at all.
 */
function fail(message) {
	process.stderr.write(`pi-tern: ${message}\n`);
	process.exit(1);
}

const installRoot = process.env.PI_MANAGED_INSTALL_ROOT || path.join(process.env.HOME ?? "", ".pi", "agent", "install");

function resolveRelease() {
	try {
		const version = readFileSync(path.join(installRoot, "current-version"), "utf8").trim();
		const pkg = path.join(installRoot, "releases", version, "node_modules", "@earendil-works", "pi-coding-agent");
		return { version, entry: path.join(pkg, "dist", "cli.js") };
	} catch {
		return null;
	}
}

/**
 * Find a stock pi to fall back to. PATH first (a developer's managed install is what this is
 * really for), then node_modules/.bin, because `@earendil-works/pi-coding-agent` is a
 * devDependency so the stock binary exists there in CI, where nothing is globally installed.
 */
function findStockPi() {
	const explicit = process.env.PI_TERN_STOCK;
	if (explicit) return explicit;
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		if (!dir) continue;
		const candidate = path.join(dir, "pi");
		if (existsSync(candidate)) return candidate;
	}
	const local = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "node_modules", ".bin", "pi");
	return existsSync(local) ? local : null;
}

function runStock(args) {
	// Recursion guard: if something aliased `pi` to this launcher, run the managed bundle directly.
	if (process.env.PI_TERN_LAUNCHED === "1") {
		const release = resolveRelease();
		if (release && existsSync(path.join(path.dirname(release.entry), "bundle", "cli.js"))) {
			const child = spawn(process.execPath, [path.join(path.dirname(release.entry), "bundle", "cli.js"), ...args], { stdio: "inherit" });
			child.on("error", (error) => fail(`could not run the managed pi bundle: ${error.message}`));
			child.on("exit", (code, signal) => {
				if (signal) process.kill(process.pid, signal);
				else process.exit(code ?? 0);
			});
			return;
		}
	}
	const stock = findStockPi();
	if (!stock) {
		fail("no stock pi found, on PATH or in node_modules/.bin. Install pi, or set PI_TERN_STOCK to its path.");
	}
	const child = spawn(stock, args, { stdio: "inherit", env: { ...process.env, PI_TERN_LAUNCHED: "1" } });
	child.on("error", (error) => fail(`could not run stock pi (${stock}): ${error.message}`));
	child.on("exit", (code, signal) => {
		if (signal) process.kill(process.pid, signal);
		else process.exit(code ?? 0);
	});
}

/** Native mode is only meaningful for the interactive TUI; never touch other modes' stdio. */
function nativeEligible(args) {
	if (process.env.PI_TERN_LAUNCHED === "1") return false;
	if (args.some((arg) => ["-p", "--print", "-h", "--help", "--version", "-V", "--export"].includes(arg))) return false;
	const modeIndex = args.indexOf("--mode");
	const mode = modeIndex >= 0 ? args[modeIndex + 1] : args.find((arg) => arg.startsWith("--mode="))?.slice("--mode=".length);
	if (mode && mode !== "text") return false;
	return true;
}

function inTern() {
	const tern = (process.env.TERM_PROGRAM ?? "").toLowerCase() === "tern";
	const mux = Boolean(process.env.TMUX || process.env.STY || process.env.ZELLIJ);
	return tern && !mux && Boolean(process.stdin.isTTY);
}

/**
 * The pi-bridge mailbox, used here without pi: it is just two JSON files in a shared directory.
 *
 * This exists for one question — what KIND of Tern block is this pane? Tern displays a TSP surface
 * only in an agent block; a terminal block accepts every frame and draws nothing. Asking after pi
 * has started (which is what 1.1.5 did) means the answer arrives once the pane is already blank and
 * native mode has to be undone; measured at 4.0 s when no window answers, which is exactly the
 * "pi-tern takes ages to render" report. Asking first costs a bounded few hundred milliseconds and
 * usually nothing at all.
 */
function mailboxDir() {
	return prod(process.env.PI_TERN_BRIDGE_DIR, path.join(home(), ".pi", "agent", "scratch", "pi-tern", "pi-bridge"));
}

function home() {
	return process.env.HOME ?? "";
}

function prod(a, b) {
	return a && a.length > 0 ? a : b;
}

/** How long we are willing to wait for a plugin to answer. Beyond this the poll is not worth it. */
const KIND_TIMEOUT_MS = Number(process.env.PI_TERN_KIND_TIMEOUT_MS || 600);

/**
 * Ask the plugin for this pane's block kind. Returns `"agent"`, another kind, or undefined when the
 * mailbox cannot answer in time. Never throws, never waits longer than `timeoutMs`, and never leaves
 * a request file behind for someone else to pick up.
 */
async function askBlockKind(paneId, timeoutMs = KIND_TIMEOUT_MS) {
	if (!paneId) return undefined;
	const dir = mailboxDir();
	const request = path.join(dir, "request.json");
	const response = path.join(dir, "response.json");
	const id = `launcher-${process.pid}-${Date.now()}`;
	try {
		// No plugin installed means no window half to answer, and no point writing a file.
		if (!existsSync(path.join(dir, "window.luau"))) return undefined;
		// A leftover response from another request must not be mistaken for ours.
		try {
			rmSync(response, { force: true });
		} catch {
			/* best effort */
		}
		writeFileSync(request, JSON.stringify({ id, op: "pane.kind", args: { pane: String(paneId) } }), "utf8");
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 40));
			let text;
			try {
				text = readFileSync(response, "utf8");
			} catch {
				continue;
			}
			try {
				const parsed = JSON.parse(text);
				if (String(parsed?.id) !== id) continue;
				return parsed.ok ? String(parsed.result?.kind ?? "") || undefined : undefined;
			} catch {
				continue;
			}
		}
	} catch {
		return undefined;
	} finally {
		try {
			rmSync(request, { force: true });
		} catch {
			/* best effort */
		}
	}
	return undefined;
}

/** Printed BEFORE pi starts, so it is readable at once and nothing has to be undone. */
/**
 * The one-line explanation for a non-agent block, said at most once a month.
 *
 * It used to be five lines on every launch, which is noise: the user knows after the first time. The
 * flag lives in the same `state.json` the extension uses, so the two halves agree and neither repeats
 * what the other already said.
 */
function nonAgentBlockNotice(kind) {
	try {
		const state = JSON.parse(readFileSync(stateFile, "utf8"));
		if (state.blockNotice && Date.now() - Number(state.blockNotice.at || 0) < 30 * 24 * 3600_000) return "";
	} catch {
		/* no state yet, or unreadable: fall through and say it once */
	}
	try {
		let state = {};
		try {
			state = JSON.parse(readFileSync(stateFile, "utf8"));
		} catch {
			/* start fresh */
		}
		state.blockNotice = { kind, at: Date.now() };
		writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
	} catch {
		/* best effort: a missing flag means one extra line, never a failure */
	}
	return `\npi-tern: Tern *${kind}* block — starting pi's own interface (native surfaces need an agent block). One command fixes it: run /tern agent-setup inside pi, or set "new_blocks": "Agent" and "agent_command": "${process.argv[1] ?? "pi-tern"}" in Tern's settings.json.\n`;
}

/** The scratch state file the extension also reads, so both halves agree on what happened. */
const stateFile = path.join(path.dirname(mailboxDir()), "state.json");

const release = resolveRelease();
const hook = fileURLToPath(new URL("./register-hook.mjs", import.meta.url));
if (!release || !existsSync(release.entry) || !existsSync(hook)) {
	runStock(process.argv.slice(2));
} else {
	const eligible = nativeEligible(process.argv.slice(2));
	const probed = eligible ? await probe() : { hello: null, reason: "not-eligible", attempts: 0 };
	const hello = probed.hello;

	// Record why the handshake failed. The old single-attempt probe fell back to stock pi silently,
	// so the only symptom of losing the race was that native mode sometimes did not engage — with
	// nothing to distinguish a lost reply from a wrong one. `/tern diagnose` reads this back.
	if (hello) {
		clearProbeFailure(stateFile);
	} else if (eligible && probed.reason) {
		recordProbeFailure(stateFile, probed.reason, probed.attempts);
		if (!process.env.PI_TERN_QUIET_PROBE && probed.attempts > 0) {
			process.stderr.write(
				`pi-tern: no TSP handshake from Tern after ${probed.attempts} attempt(s) (${probed.reason}); starting stock pi.\n`,
			);
		}
	}

	if (process.env.PI_TERN_TSP_RECORD && hello) {
		try {
			appendFileSync(process.env.PI_TERN_TSP_RECORD, `${JSON.stringify({ t: Date.now(), dir: "in", verb: "r", body: hello })}\n`);
		} catch {
			/* best effort */
		}
	}
	if (!hello) {
		runStock(process.argv.slice(2));
	} else {
		// Decide BEFORE going native. Native mode is the special case: it is only correct when Tern will
		// actually display the surface, and the one place that is known is an agent block. Anything
		// else — a terminal block, an unresponsive mailbox, an unknown kind — starts pi's own
		// interface, which works everywhere. Asking afterwards (1.1.5) meant the answer arrived after
		// pi had already gone native, so the pane sat blank for as long as the plugin took to reply.
		const forced = process.env.PI_TERN_NATIVE_BLOCK;
		const skipCheck = process.env.PI_TERN_SKIP_KIND_CHECK === "1" || forced === "force";
		const kind = skipCheck ? "agent" : await askBlockKind(process.env.TERN_PANE);
		if (kind !== "agent") {
			process.stderr.write(nonAgentBlockNotice(kind ?? "terminal (pi-bridge did not answer)"));
			runStock(process.argv.slice(2));
		} else {
			const child = spawn(process.execPath, ["--disable-warning=DEP0205", "--import", hook, release.entry, ...process.argv.slice(2)], {
				stdio: "inherit",
				env: {
					...process.env,
					PI_TERN_NATIVE: "1",
					PI_TERN_HELLO: JSON.stringify(hello),
					PI_TERN_BLOCK_KIND: skipCheck ? "forced" : "agent",
					...(process.env.TERN_PANE ? { PI_TERN_SURFACE_ID: `pi-${process.env.TERN_PANE}` } : {}),
				},
			});
			child.on("exit", (code, signal) => {
				if (signal) process.kill(process.pid, signal);
				else process.exit(code ?? 0);
			});
		}
	}
}
