/**
 * The Tern 0.9 session verbs pi-tern drives: `process`, `rename`, `move`, `pip`, `dock`, `whoami`.
 *
 * These arrived after 0.5.x, and each one replaces a workaround:
 *
 *   `process`   what a pane is actually running (pid, argv, cwd) — `tern_capture` can only show
 *               what it printed, and `tern_panes` only what the daemon was told at spawn time.
 *   `whoami`    the identity chain (see lib/identity.ts) instead of guessing from `TERM_PROGRAM`.
 *   `pip`/`dock` a block as a picture-in-picture over another, and back — the layout operation
 *               `tern_browser` already uses for its WKWebView pane, now addressable for any block.
 *   `move`      a block beside/above/left-of/right-of another, or into a tab.
 *   `rename`    a session or block tab name, which is how a fleet member stops being "node".
 *
 * Everything is `--json` and parsed, and every call takes the runner so the argument shapes are
 * testable without a Tern install (see test/session.test.ts). Availability is the caller's job:
 * `sessionVerbSupport()` in lib/tern.ts is what turns "0.5.x has no such verb" into a reason
 * instead of a `tern whoami: No such file or directory` that reads like a bug.
 */
import { runTern, type RunResult } from "./tern.ts";

export type Runner = (args: string[], timeoutMs?: number) => Promise<RunResult>;

export interface ProcessInfo {
	pid: number;
	name: string;
	argv: string[];
	cwd: string;
}

/** `tern process BLOCK --json`, as measured on Tern 0.9.8. */
export interface PaneProcess {
	pane: number;
	child?: ProcessInfo;
	group?: number;
	foreground?: ProcessInfo;
	/** Fields this build does not model, kept rather than dropped. */
	extra?: Record<string, unknown>;
}

/** A verb's `--json` answer; only `whoami`/`process` have shapes worth modelling. */
export type SessionResult = Record<string, unknown>;

const KNOWN_PROCESS_FIELDS = new Set(["pane", "child", "group", "foreground"]);

function processInfo(raw: unknown): ProcessInfo | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const record = raw as Record<string, unknown>;
	const pid = typeof record.pid === "number" ? record.pid : Number(record.pid);
	if (!Number.isFinite(pid)) return undefined;
	return {
		pid,
		name: typeof record.name === "string" ? record.name : "",
		argv: Array.isArray(record.argv) ? record.argv.map(String) : [],
		cwd: typeof record.cwd === "string" ? record.cwd : "",
	};
}

/**
 * Read `tern process --json`.
 *
 * `child` is the program the block was started with and `foreground` what holds the terminal
 * right now — a shell that was started to run one command and is now at a prompt has both, and
 * they differ. A body without a numeric `pane` is not a process answer and returns null.
 */
export function parsePaneProcess(raw: unknown): PaneProcess | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const record = raw as Record<string, unknown>;
	const pane = typeof record.pane === "number" ? record.pane : Number(record.pane);
	if (!Number.isFinite(pane)) return null;
	const parsed: PaneProcess = { pane };
	const child = processInfo(record.child);
	if (child) parsed.child = child;
	const foreground = processInfo(record.foreground);
	if (foreground) parsed.foreground = foreground;
	const group = typeof record.group === "number" ? record.group : Number(record.group);
	if (Number.isFinite(group)) parsed.group = group;
	const extra: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(record)) {
		if (!KNOWN_PROCESS_FIELDS.has(key)) extra[key] = value;
	}
	if (Object.keys(extra).length > 0) parsed.extra = extra;
	return parsed;
}

/**
 * A user-supplied value that Tern's own parser would read as an option.
 *
 * Measured on 0.9.8: `tern rename "@focused" "--window=0"` swallows the value as a flag and then
 * fails with a usage error that names neither the flag nor the value, and `tern move --nonsense`
 * answers `unknown flag --nonsense`. A leading `-` is therefore always an option, never a name or a
 * block id. `--` does not rescue it either — `tern rename -- A B` is still a usage error — so the
 * value has to be refused here rather than escaped at the call site.
 */
function value(raw: string | number, what: string): string {
	const text = String(raw);
	if (text.startsWith("-")) {
		throw new Error(
			`${what} cannot start with '-' because Tern reads it as a flag: ${JSON.stringify(text)}`,
		);
	}
	return text;
}

/** Run one `--json` verb and parse the answer, with Tern's own message when it refuses. */
async function runJson(run: Runner, args: string[], timeoutMs: number): Promise<unknown> {
	const result = await run(args, timeoutMs);
	if (result.timedOut) throw new Error(`tern ${args[0]} timed out`);
	if (result.code !== 0) {
		const detail = (result.stderr || result.stdout).trim();
		throw new Error(detail || `tern ${args[0]} exited ${result.code}`);
	}
	try {
		return JSON.parse(result.stdout) as unknown;
	} catch {
		throw new Error(`tern ${args[0]} did not answer with JSON: ${result.stdout.slice(0, 200)}`);
	}
}

/** What is running in a pane: `tern process BLOCK --json`. */
export async function paneProcess(block: string | number, run: Runner = runTern, timeoutMs = 15000): Promise<PaneProcess> {
	const parsed = parsePaneProcess(await runJson(run, ["process", value(block, "block"), "--json"], timeoutMs));
	if (!parsed) throw new Error("tern process answered with no pane");
	return parsed;
}

/** `tern rename SESSION|BLOCK NAME --json`. */
export async function renameTarget(target: string, name: string, run: Runner = runTern, timeoutMs = 15000): Promise<SessionResult> {
	return (await runJson(run, ["rename", value(target, "target"), value(name, "name"), "--json"], timeoutMs)) as SessionResult;
}

export type MoveHow = "below" | "above" | "left-of" | "right-of";

/** `tern move BLOCK how BLOCK --json`, or `tern move BLOCK tab N|new-tab`. */
export async function moveBlock(
	block: string | number,
	how: MoveHow | "tab",
	destination: string | number,
	run: Runner = runTern,
	timeoutMs = 15000,
): Promise<SessionResult> {
	return (await runJson(
		run,
		["move", value(block, "block"), how, value(destination, "destination"), "--json"],
		timeoutMs,
	)) as SessionResult;
}

export type Corner = "tl" | "tr" | "bl" | "br";

/** `tern pip BLOCK [--over BLOCK] [--corner C] --json`: float a block as a picture in picture. */
export async function pipBlock(
	block: string | number,
	options: { over?: string | number; corner?: Corner } = {},
	run: Runner = runTern,
	timeoutMs = 15000,
): Promise<SessionResult> {
	const args = ["pip", value(block, "block")];
	if (options.over !== undefined) args.push("--over", value(options.over, "over"));
	if (options.corner) args.push("--corner", options.corner);
	args.push("--json");
	return (await runJson(run, args, timeoutMs)) as SessionResult;
}

export type DockSide = "left" | "right" | "up" | "down";

/** `tern dock BLOCK [side] --json`: put a picture in picture back into the split. */
export async function dockBlock(
	block: string | number,
	side?: DockSide,
	run: Runner = runTern,
	timeoutMs = 15000,
): Promise<SessionResult> {
	const args = ["dock", value(block, "block")];
	if (side) args.push(side);
	args.push("--json");
	return (await runJson(run, args, timeoutMs)) as SessionResult;
}

/** `tern keep-open BLOCK on|off --json`. */
export async function keepPaneOpen(
	block: string | number,
	open: boolean,
	run: Runner = runTern,
	timeoutMs = 15000,
): Promise<SessionResult> {
	return (await runJson(run, ["keep-open", value(block, "block"), open ? "on" : "off", "--json"], timeoutMs)) as SessionResult;
}
