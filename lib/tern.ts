/**
 * Tern environment detection and CLI helpers.
 */
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

/**
 * Tern's settings file, which is where agent blocks are configured.
 *
 * Two keys decide whether native surfaces can appear at all, and they are what makes a
 * "terminal block" notice actionable instead of annoying:
 *   `new_blocks`    — "what new tabs and splits open": `Shell` or `Agent`
 *   `agent_command` — "what a block runs": the login shell, or this command (defaults to `omp`)
 * Set both and every new tab is an *agent* block running pi-tern — the only kind of block in which
 * Tern draws a TSP surface.
 */
export function ternSettingsPath(): string {
	return path.join(os.homedir(), "Library", "Application Support", "Tern", "settings.json");
}

/**
 * Where the settings file lives. Every path helper takes this so tests can point at a temp file:
 * this is the one function in pi-tern that writes outside its own sandbox, so it must never be
 * the reason a test run touches a real Tern install.
 */
export interface TernSettingsIo {
	/** Absolute path to settings.json. */
	file: string;
	/** Read the current contents, or `null` when the file does not exist yet. */
	read(): string | null;
	/** Overwrite the file. */
	write(contents: string): void;
}

/** The real one: Tern's settings.json under Application Support. */
export function defaultTernSettingsIo(): TernSettingsIo {
	const file = ternSettingsPath();
	return {
		file,
		read: () => {
			try {
				return readFileSync(file, "utf8");
			} catch {
				// ENOENT is the normal case on a fresh Tern install, and it must not throw here:
				// /tern agent-setup is exactly the command someone runs to fix a broken setup.
				return null;
			}
		},
		write: (contents: string) => {
			mkdirSync(path.dirname(file), { recursive: true });
			writeFileSync(file, contents, "utf8");
		},
	};
}

export function readTernSettings(io: TernSettingsIo = defaultTernSettingsIo()): Record<string, unknown> {
	try {
		const raw = io.read();
		if (raw === null) return {};
		return JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return {};
	}
}

/**
 * Make pi-tern the agent Tern starts, so new tabs are agent blocks and native surfaces display.
 * Backs the file up first and reports exactly what changed; Tern reloads on save, so no restart.
 *
 * `alreadySet` comes back true when both keys were already correct, which is the "do not rewrite a
 * file that needs no change" case — it must not produce a backup either.
 */
export function setTernAgentDefaults(
	agentCommand: string,
	io: TernSettingsIo = defaultTernSettingsIo(),
): { file: string; backup: string | null; changed: string[]; alreadySet: boolean } {
	const before = io.read();
	let current: Record<string, unknown> = {};
	if (before !== null) {
		try {
			current = JSON.parse(before) as Record<string, unknown>;
		} catch (error) {
			// Refuse to overwrite a settings file we cannot parse: the user's window size, theme
			// and keybindings are in there too, and losing them to a typo here would be far worse
			// than this command not working.
			throw new Error(
				`${io.file} is not valid JSON (${error instanceof Error ? error.message : String(error)}). ` +
					`Fix or move it, then run this again. Nothing was changed.`,
			);
		}
	}

	const changed: string[] = [];
	const previousNewBlocks = String(current.new_blocks ?? "unset");
	if (current.new_blocks !== "Agent") {
		current.new_blocks = "Agent";
		changed.push(`new_blocks: ${JSON.stringify(previousNewBlocks)} → "Agent"`);
	}
	const previousAgent = String(current.agent_command ?? "unset");
	if (current.agent_command !== agentCommand) {
		current.agent_command = agentCommand;
		changed.push(`agent_command: ${JSON.stringify(previousAgent)} → ${JSON.stringify(agentCommand)}`);
	}

	if (changed.length === 0) {
		// Nothing to do, so nothing is written and no backup is taken.
		return { file: io.file, backup: null, changed, alreadySet: true };
	}

	// Only back up when there is something to back up: on a fresh install there is no file yet,
	// and writing `${file}.bak-...` next to a non-existent settings.json would be litter.
	const backup =
		before === null
			? null
			: (() => {
					const target = `${io.file}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
					writeFileSync(target, before, "utf8");
					return target;
				})();

	io.write(`${JSON.stringify(current, null, 2)}\n`);
	return { file: io.file, backup, changed, alreadySet: false };
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
