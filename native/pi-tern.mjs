#!/usr/bin/env node
/**
 * pi-tern launcher: probes Tern for TSP support, then runs pi through the
 * unbundled entry with the native loader hook. Falls back to the stock pi
 * launcher whenever anything is missing or Tern does not answer.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
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
const hook = path.join(path.dirname(new URL(import.meta.url).pathname), "register-hook.mjs");
if (!release || !existsSync(release.entry) || !existsSync(hook)) {
	runStock(process.argv.slice(2));
} else {
	const hello = nativeEligible(process.argv.slice(2)) ? await probe() : null;
	if (!hello) {
		runStock(process.argv.slice(2));
	} else {
		const child = spawn(process.execPath, ["--import", hook, release.entry, ...process.argv.slice(2)], {
			stdio: "inherit",
			env: { ...process.env, PI_TERN_NATIVE: "1", PI_TERN_HELLO: JSON.stringify(hello) },
		});
		child.on("exit", (code, signal) => {
			if (signal) process.kill(process.pid, signal);
			else process.exit(code ?? 0);
		});
	}
}
