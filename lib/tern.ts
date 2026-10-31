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
	/**
	 * The rest of what a 0.9.x pane exports, all optional.
	 *
	 * Measured in a real 0.9.8 pane: `TERN_IDENTITY` (the whoami chain as JSON), `TERN_CONFIG_DIR`,
	 * `TERN_EXE`, `TERN_BLOB_DIR`, `TERN_COMPLETE`. Older builds export none of these, so nothing
	 * may require them — each one is a cheaper source for something pi-tern otherwise has to ask
	 * Tern for, or has to guess.
	 */
	configDir?: string;
	daemonSocket?: string;
	identity?: string;
	exe?: string;
}

export function readTernEnv(env: NodeJS.ProcessEnv = process.env): TernEnv {
	const e = env;
	return {
		inTern: (e.TERM_PROGRAM ?? "").toLowerCase() === "tern",
		version: e.TERM_PROGRAM_VERSION,
		paneId: e.TERN_PANE,
		paneSocket: e.TERN_PANE_SOCKET,
		windowSocket: e.TERN_WINDOW_SOCKET || undefined,
		windowKey: e.TERN_WINDOW_KEY || undefined,
		configDir: e.TERN_CONFIG_DIR || undefined,
		daemonSocket: e.TERN_DAEMON_SOCKET || undefined,
		identity: e.TERN_IDENTITY || undefined,
		exe: e.TERN_EXE || undefined,
	};
}

/**
 * A Tern CLI version, as `tern --version` prints it.
 *
 * The CLI answers `0.9.8 (f21d9a3)`: a semver triple and the build's commit. Newer builds have
 * added verbs (0.9.x brought `whoami`, `process`, `pip`, `dock`, `serve` and `plugin types`), so
 * the number is the only thing that can tell a capability probe what it may call. Before 1.2
 * there was no version parsing at all — pi-tern assumed every Tern had every verb it used, which
 * is why a 0.5.x user got `unknown command` instead of an explanation.
 */
export interface TernVersion {
	/** The first line exactly as printed. */
	raw: string;
	/** The dotted triple, without a leading `v` or a trailing `-beta`. */
	version: string;
	major: number;
	minor: number;
	patch: number;
	/** The build commit Tern prints in parentheses, when it does. */
	commit?: string;
}

export function parseTernVersion(raw: string | undefined | null): TernVersion | null {
	if (typeof raw !== "string") return null;
	const first = raw.split("\n")[0].trim();
	if (first.length === 0) return null;
	// `tern 0.9.8`, `0.9.8 (f21d9a3)` and `v0.9.8` all name the same build.
	const match = first.match(/(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?/);
	if (!match) return null;
	const major = Number(match[1]);
	const minor = Number(match[2]);
	const patch = Number(match[3]);
	if (![major, minor, patch].every((part) => Number.isFinite(part))) return null;
	const version: TernVersion = { raw: first, version: `${major}.${minor}.${patch}`, major, minor, patch };
	const commit = first.match(/\(([0-9a-f]{4,40})\)/i)?.[1];
	if (commit) version.commit = commit;
	return version;
}

/** Compare against a dotted minimum, e.g. `versionAtLeast(v, "0.9.0")`. Unparseable → false. */
export function versionAtLeast(version: TernVersion | null | undefined, minimum: string): boolean {
	if (!version) return false;
	const floor = parseTernVersion(minimum);
	if (!floor) return false;
	if (version.major !== floor.major) return version.major > floor.major;
	if (version.minor !== floor.minor) return version.minor > floor.minor;
	return version.patch >= floor.patch;
}

/**
 * The Tern release that introduced the session verbs pi-tern 1.2 drives.
 *
 * 0.9.8 was measured directly (`tern whoami --json`, `tern process --json`); 0.5.2 was not
 * available to measure against, so this is the boundary pi-tern will *state*, and `PI_TERN_FORCE=1`
 * is the escape hatch if a fork backports a verb.
 */
export const SESSION_VERBS_SINCE = "0.9.0";

export type SessionVerb =
	| "whoami"
	| "process"
	| "rename"
	| "move"
	| "pip"
	| "dock"
	| "keep-open"
	| "split"
	| "focus";

export interface VerbSupport {
	supported: boolean;
	version?: string;
	reason?: string;
}

/**
 * Whether this Tern build can be asked `verb` (a CLI verb introduced with the 0.9 session set).
 *
 * A missing verb is not a crash — `tern whoami` on a build without it opens a directory called
 * `whoami` — so the check is made before the call, not after it fails.
 */
export function cliVerbSupport(
	availability: Pick<TernAvailability, "cli" | "release"> | null | undefined,
	verb: string,
): VerbSupport {
	if (process.env.PI_TERN_FORCE === "1") return { supported: true, reason: undefined };
	if (!availability?.cli) return { supported: false, reason: "the `tern` command did not answer on PATH" };
	const release = availability.release ?? null;
	if (release && versionAtLeast(release, SESSION_VERBS_SINCE)) return { supported: true, version: release.version };
	return {
		supported: false,
		reason: release
			? `\`tern ${verb}\` needs Tern ${SESSION_VERBS_SINCE} or newer; this is ${release.version}. Everything else still works.`
			: `\`tern ${verb}\` needs Tern ${SESSION_VERBS_SINCE} or newer and this CLI did not report a version`,
	};
}

/** `sessionVerbSupport` is `cliVerbSupport` for the verb union, so the two cannot drift apart. */
export function sessionVerbSupport(
	availability: Pick<TernAvailability, "cli" | "release"> | null | undefined,
	verb: SessionVerb,
): VerbSupport {
	return cliVerbSupport(availability, verb);
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
export function ternSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
	return path.join(ternConfigDir(env), "settings.json");
}

/**
 * Tern's state directory: settings.json, the plugins directory, session state.
 *
 * `TERN_CONFIG_DIR` overrides it, and a 0.9.8 pane exports it — so `/tern agent-setup` editing a
 * hard-coded `~/Library/Application Support/Tern/settings.json` would silently write to a file the
 * running Tern is not reading, report success, and change nothing. That is the same class of bug as
 * a stale plugin version, so the override is honoured here rather than assumed away.
 */
export function ternConfigDir(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.TERN_CONFIG_DIR?.trim();
	if (override) return override;
	return path.join(os.homedir(), "Library", "Application Support", "Tern");
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
	/** The same answer, parsed: what the capability gates compare against. */
	release?: TernVersion | null;
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
		release: parseTernVersion(version),
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
