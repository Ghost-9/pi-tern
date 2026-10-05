/**
 * Tern testing/inspection helpers: pane capture and control-endpoint commands.
 */
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
