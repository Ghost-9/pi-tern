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
import { encodeHello, extractMessages, isHelloReply } from "./tsp.mjs";

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

function runStock(args) {
	// Recursion guard: if something aliased `pi` to this launcher, run the managed bundle directly.
	if (process.env.PI_TERN_LAUNCHED === "1") {
		const release = resolveRelease();
		if (release && existsSync(path.join(path.dirname(release.entry), "bundle", "cli.js"))) {
			const child = spawn(process.execPath, [path.join(path.dirname(release.entry), "bundle", "cli.js"), ...args], { stdio: "inherit" });
			child.on("exit", (code, signal) => (signal ? process.kill(process.pid, signal) : process.exit(code ?? 0)));
			return;
		}
	}
	const stock = process.env.PI_TERN_STOCK || "pi";
	const child = spawn(stock, args, { stdio: "inherit", env: { ...process.env, PI_TERN_LAUNCHED: "1" } });
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
function nonAgentBlockNotice(kind) {
	return [
		"",
		`pi-tern: this is a Tern *${kind}* block, so native surfaces would not be displayed here.`,
		"Tern draws a TSP surface only in an agent block; a terminal block accepts the frames and",
		"shows nothing, which is why this used to come up blank. Starting pi's own interface instead.",
		"",
		"To get native surfaces:",
		"  • open an agent block — the tab's + menu, then an agent block",
		"  • or point Tern's agent_command at pi-tern, in ~/Library/Application Support/Tern/settings.json:",
		`      "agent_command": "${process.argv[1] ?? "pi-tern"}"`,
		"  • or force it anyway:  PI_TERN_NATIVE_BLOCK=force pi-tern",
		"",
	].join("\n");
}

function probe(timeoutMs = 700) {
	if (!inTern() || process.env.PI_TERN_DISABLE_NATIVE === "1") return Promise.resolve(null);
	return new Promise((resolve) => {
		const wasRaw = process.stdin.isRaw;
		let buffer = "";
		const finish = (hello) => {
			process.stdin.off("data", onData);
			try {
				process.stdin.setRawMode(Boolean(wasRaw));
			} catch {
				/* ignore */
			}
			process.stdin.pause();
			clearTimeout(timer);
			resolve(hello);
		};
		const onData = (chunk) => {
			buffer += String(chunk);
			const { messages } = extractMessages(buffer);
			const hello = messages.map((message) => (isHelloReply(message) ? message.body : null)).find(Boolean);
			if (hello) finish(hello);
		};
		try {
			process.stdin.setRawMode(true);
		} catch {
			resolve(null);
			return;
		}
		process.stdin.resume();
		process.stdin.on("data", onData);
		process.stdout.write(encodeHello());
		// DA1 sentinel: Tern answers the hello before this reply.
		process.stdout.write("\x1b[c");
		const timer = setTimeout(() => finish(null), timeoutMs);
	});
}

const release = resolveRelease();
const hook = fileURLToPath(new URL("./register-hook.mjs", import.meta.url));
if (!release || !existsSync(release.entry) || !existsSync(hook)) {
	runStock(process.argv.slice(2));
} else {
	const hello = nativeEligible(process.argv.slice(2)) ? await probe() : null;
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
