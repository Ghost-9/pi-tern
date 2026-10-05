/**
 * Tern testing/inspection helpers: pane capture, control-endpoint commands and
 * control-endpoint bootstrap.
 */
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { runTern, type TernEnv } from "./tern.ts";

const CONTROL_COMMANDS = new Set([
	"dump",
	"tree",
	"pick",
	"state",
	"stats",
	"layers",
	"a11y",
	"menus",
	"system",
	"css",
	"perf",
	"trace",
	"resize",
	"thaw",
	"webcall",
	"webreports",
]);

export interface CaptureFlags {
	ansi?: boolean;
	html?: boolean;
	scrollback?: boolean;
	surfaces?: boolean;
}

export async function capturePane(
	block: string | undefined,
	flags: CaptureFlags,
	timeoutMs = 30000,
): Promise<string> {
	const args = ["capture", block && block.length > 0 ? block : "@focused"];
	if (flags.ansi) args.push("--ansi");
	if (flags.html) args.push("--html");
	if (flags.scrollback) args.push("--scrollback");
	if (flags.surfaces) args.push("--surfaces");
	const result = await runTern(args, timeoutMs);
	if (result.code !== 0 || result.timedOut) {
		throw new Error(
			result.timedOut ? "tern capture timed out" : result.stderr.trim() || `tern capture exited ${result.code}`,
		);
	}
	return result.stdout;
}

export async function controlCommand(
	env: TernEnv,
	command: string[],
	controlOverride?: string,
	timeoutMs = 30000,
): Promise<string> {
	if (command.length === 0) throw new Error("empty control command");
	const verb = command[0];
	if (!CONTROL_COMMANDS.has(verb)) {
		throw new Error(`control command '${verb}' is not allowed (allowed: ${[...CONTROL_COMMANDS].join(", ")})`);
	}
	const endpoint = controlOverride || env.windowSocket;
	if (!endpoint) {
		throw new Error(
			"no control endpoint for this window: launch Tern with --control EP (or set TERN_WINDOW_SOCKET)",
		);
	}
	const result = await runTern(["ctl", "--control", endpoint, ...command], timeoutMs);
	if (result.code !== 0) {
		throw new Error(result.stderr.trim() || result.stdout.trim() || `tern ctl exited ${result.code}`);
	}
	return result.stdout;
}

export async function listPanes(timeoutMs = 15000): Promise<string> {
	const result = await runTern(["ls", "--json"], timeoutMs);
	if (result.code !== 0) throw new Error(result.stderr.trim() || `tern ls exited ${result.code}`);
	return result.stdout;
}

/** Poll a pane's visible text until the pattern appears (dev servers, builds, prompts). */
export async function waitForText(
	block: string,
	pattern: string,
	timeoutMs: number,
	intervalMs = 500,
): Promise<{ matched: boolean; output: string; waitedMs: number }> {
	const regex = new RegExp(pattern, "m");
	const started = Date.now();
	let output = "";
	while (Date.now() - started < timeoutMs) {
		try {
			output = await capturePane(block, {});
		} catch {
			output = "";
		}
		if (regex.test(output)) return { matched: true, output, waitedMs: Date.now() - started };
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
	return { matched: false, output, waitedMs: Date.now() - started };
}

/** Render offscreen Tern scenarios to PNG + layout JSON (`tern shot`). */
export async function shotScenarios(
	scenarios: string[],
	outDir: string,
	timeoutMs = 180000,
): Promise<{ files: string[]; output: string; code: number }> {
	const args = ["shot", "--out", outDir, ...scenarios];
	const result = await runTern(args, timeoutMs);
	const files: string[] = [];
	try {
		for (const entry of readdirSync(outDir, { recursive: true })) files.push(String(entry));
	} catch {
		/* no output directory */
	}
	return { files, output: `${result.stdout}${result.stderr}`.trim(), code: result.code };
}

/** `tern remote hosts` / `tern remote discover` (empty until a host is trusted). */
export async function remoteHosts(action: "hosts" | "discover" = "hosts", timeoutMs = 20000): Promise<string> {
	const result = await runTern(["remote", action], timeoutMs);
	if (result.code !== 0) throw new Error(result.stderr.trim() || `tern remote ${action} exited ${result.code}`);
	return result.stdout.trim();
}

/**
 * Start a Tern window (or a headless `tern serve`) bound to a control endpoint and
 * wait until it answers. The process is detached so it outlives this pi session.
 */
export async function bootstrapControl(
	kind: "window" | "headless",
	socketPath: string,
	waitMs = 8000,
): Promise<string> {
	const args = kind === "headless" ? ["serve", "--control", socketPath] : ["--control", socketPath];
	const child = spawn("tern", args, { detached: true, stdio: "ignore" });
	child.unref();
	const deadline = Date.now() + waitMs;
	let lastError = "control endpoint did not answer";
	while (Date.now() < deadline) {
		const probe = await runTern(["ctl", "--control", socketPath, "state"], 2000);
		if (probe.code === 0) return socketPath;
		lastError = probe.stderr.trim() || probe.stdout.trim() || lastError;
		await new Promise((resolve) => setTimeout(resolve, 300));
	}
	throw new Error(`${lastError} (endpoint: ${socketPath})`);
}
