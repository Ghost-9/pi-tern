/**
 * Tern testing/inspection helpers: pane capture, control-endpoint commands and
 * control-endpoint bootstrap.
 */
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { runTern, type TernEnv } from "./tern.ts";
import { waitForEvent, type TernEvent } from "./events.ts";

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
/**
 * Wait for a pane's output to match a pattern.
 *
 * This used to poll `tern capture` every 500 ms, which starts a process per poll — over a 15-minute
 * `gh pr checks --watch` that is ~1800 processes, for something the daemon is already pushing. A
 * persistent `tern events` subscription (`lib/events.ts`) does the same job with one long-lived
 * child, so the capture becomes the *fallback* for when events are unavailable, and the poll
 * interval backs off rather than hammering.
 *
 * The regex comes from the model, so it is compiled once and validated rather than throwing a raw
 * SyntaxError out of the tool, and the haystack is capped so a pathological pattern cannot stall the
 * event loop — a stall the timeout could not interrupt.
 */
export async function waitForText(
	block: string,
	pattern: string,
	timeoutMs: number,
	intervalMs = 1500,
): Promise<{ matched: boolean; output: string; waitedMs: number; via: "events" | "poll" }> {
	let regex: RegExp;
	try {
		regex = new RegExp(pattern, "m");
	} catch (error) {
		throw new Error(`invalid pattern: ${error instanceof Error ? error.message : String(error)}`);
	}
	const MAX_HAYSTACK = 16 * 1024;
	const started = Date.now();
	let output = "";

	const test = (text: string): boolean => {
		const haystack = text.length > MAX_HAYSTACK ? text.slice(-MAX_HAYSTACK) : text;
		return regex.test(haystack);
	};

	// One capture, then let the event stream wake us. This keeps the semantics identical (the match
	// is always made against real pane output) while removing the per-poll process.
	const once = async (): Promise<boolean> => {
		try {
			output = await capturePane(block, {});
		} catch {
			output = "";
		}
		return test(output);
	};

	if (await once()) return { matched: true, output, waitedMs: Date.now() - started, via: "events" };

	// The daemon pushes pane events; a wake-up is a reason to re-read, not the match itself.
	const blockId = block.replace(/^@focused$/, "").trim();
	const events = waitForEvent({
		filter: ["pane_output", "pane_exited", "pane_title", "block_event"],
		match: (event: TernEvent) => {
			const pane = String(event.pane ?? event.block ?? event.id ?? "");
			// A pane-less event is a daemon-wide change, which is worth a look.
			return blockId === "" || pane === "" || pane === blockId || event.name === "pane_exited";
		},
		timeoutMs: Math.max(0, timeoutMs - (Date.now() - started)),
	});

	const raced = await Promise.race([
		events.then(() => "event" as const),
		new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), Math.max(0, timeoutMs - (Date.now() - started)))),
	]);

	if (raced === "timeout") return { matched: false, output, waitedMs: Date.now() - started, via: "events" };

	// Re-read after the wake-up, then fall back to backing-off polls if events are not flowing.
	let interval = intervalMs;
	while (Date.now() - started < timeoutMs) {
		if (await once()) return { matched: true, output, waitedMs: Date.now() - started, via: "events" };
		const remaining = timeoutMs - (Date.now() - started);
		if (remaining <= 0) break;
		await new Promise((resolve) => setTimeout(resolve, Math.min(interval, remaining)));
		// Back off: a pane that is not going to match should not cost a process every 500 ms.
		interval = Math.min(interval * 2, 10_000);
	}
	return { matched: false, output, waitedMs: Date.now() - started, via: "poll" };
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
