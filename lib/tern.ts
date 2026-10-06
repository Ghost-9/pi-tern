/**
 * Tern environment detection and CLI helpers.
 */
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface TernEnv {
	inTern: boolean;
	version?: string;
	paneId?: string;
	paneSocket?: string;
	windowSocket?: string;
	windowKey?: string;
}

export function readTernEnv(): TernEnv {
	const e = process.env;
	return {
		inTern: (e.TERM_PROGRAM ?? "").toLowerCase() === "tern",
		version: e.TERM_PROGRAM_VERSION,
		paneId: e.TERN_PANE,
		paneSocket: e.TERN_PANE_SOCKET,
		windowSocket: e.TERN_WINDOW_SOCKET || undefined,
		windowKey: e.TERN_WINDOW_KEY || undefined,
	};
}

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

export function runTern(args: string[], timeoutMs = 30000): Promise<RunResult> {
	return new Promise((resolve) => {
		execFile(
			"tern",
			args,
			{ timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" },
			(error, stdout, stderr) => {
				const err = error as (Error & { code?: number | string; killed?: boolean }) | null;
				resolve({
					code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
					stdout: stdout ?? "",
					stderr: stderr ?? "",
					timedOut: err?.killed === true,
				});
			},
		);
	});
}

/** Scratch dir for generated diagrams. Memoised per home directory: this is called several times per turn. */
let scratchDirCache: { home: string; dir: string } | undefined;
export function scratchDir(): string {
	// Keyed on the resolved home, not cached globally: tests (and anyone changing HOME) must get
	// the directory their environment actually points at.
	const home = os.homedir();
	if (scratchDirCache && scratchDirCache.home === home) return scratchDirCache.dir;
	const dir = path.join(home, ".pi", "agent", "scratch", "pi-tern");
	mkdirSync(dir, { recursive: true });
	scratchDirCache = { home, dir };
	return dir;
}

export function assertTern(env: TernEnv, what: string): void {
	if (!env.inTern && process.env.PI_TERN_FORCE !== "1") {
		throw new Error(`${what} needs a Tern pane (TERM_PROGRAM=tern). Set PI_TERN_FORCE=1 to try anyway.`);
	}
}

/**
 * Availability of the *Tern daemon* (not a pane). Every CLI-backed feature
 * (`tern open`, `tern browser`, `tern capture`, `tern send`, `tern new`) works
 * from anywhere — a T3-hosted agent, a cron job, a plain terminal — as long as a
 * Tern window or daemon is running. Only surface/probe/relay features need a pane.
 */
export interface TernAvailability {
	inPane: boolean;
	cli: boolean;
	version?: string;
	reason?: string;
}

let availabilityCache: { at: number; value: TernAvailability } | undefined;

/** Probe `tern --version` (cached for a few seconds so per-call cost is nil). */
export async function ternAvailable(refresh = false): Promise<TernAvailability> {
	const now = Date.now();
	if (!refresh && availabilityCache && now - availabilityCache.at < 5000) return availabilityCache.value;
	const inPane = readTernEnv().inTern;
	const result = await runTern(["--version"], 4000);
	const version = result.stdout.trim() || result.stderr.trim();
	const cli = result.code === 0 && /tern/i.test(version);
	const value: TernAvailability = {
		inPane,
		cli,
		version: version || undefined,
		reason: cli
			? undefined
			: insideMultiplexer()
				? "inside tmux/screen/zellij, where Tern panes cannot be reached"
				: "the `tern` command did not answer on PATH",
	};
	availabilityCache = { at: now, value };
	return value;
}

/** Throw a helpful error unless the Tern CLI answers (pane not required). */
export async function requireTernCli(what: string): Promise<TernAvailability> {
	if (process.env.PI_TERN_FORCE === "1") return { inPane: readTernEnv().inTern, cli: true };
	const availability = await ternAvailable();
	if (!availability.cli) {
		throw new Error(
			`${what} needs a running Tern: ${availability.reason ?? "unavailable"}. ` +
				"Start Tern (or a `tern serve` daemon) — a Tern pane is not required. " +
				"Set PI_TERN_FORCE=1 to bypass this check.",
		);
	}
	return availability;
}

/** True when a Tern pane is required and absent (probe, relay, surface writes). */
export function paneRequired(what: string): void {
	const env = readTernEnv();
	if (!env.inTern && process.env.PI_TERN_FORCE !== "1") {
		throw new Error(
			`${what} needs a Tern pane (TERM_PROGRAM=tern) — it uses this pane's pty, not the daemon. ` +
				"Run it from a Tern pane, or use the CLI-backed tools (tern_diagram, tern_browser, tern_capture, tern_run, tern_fleet) which work anywhere Tern is running.",
		);
	}
}

/** tmux/screen/zellij swallow APC strings, so the TSP handshake cannot work there. */
export function insideMultiplexer(): boolean {
	return Boolean(process.env.TMUX || process.env.STY || process.env.ZELLIJ);
}
