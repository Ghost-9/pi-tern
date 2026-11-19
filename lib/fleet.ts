/**
 * Fleet: panes as threads.
 *
 * A "thread" here is a Tern pane running an agent or a command, addressed by its
 * block id. The transport is all first-party Tern CLI:
 *
 *   spawn  -> `tern new tab --json --keep-open [--cwd X] -- <cmd>`
 *   steer  -> `tern send BLOCK text "..."` + `tern send BLOCK keys Enter`
 *   read   -> `tern capture BLOCK [--scrollback]`
 *   wait   -> `tern wait BLOCK --until exit --timeout N`
 *   stop   -> `tern kill BLOCK` / `tern close BLOCK`
 *   prune  -> close panes whose command exited long ago (see fleetPrune)
 *
 * A member may instead be spawned `bg: true` (detached, "no pane"): the command is started in its
 * own session with `setsid`, its output goes to a log file and its pid to a pid file, and the pane
 * is created *without* `--keep-open` so it disappears the instant the wrapper returns. read/wait/
 * stop then work off the log and the process group, not off a pane — which is what keeps a
 * resident agent (`claude --bg`, `codex app-server daemon`, `opencode serve`) reachable from a
 * headless agent without occupying Tern real estate.
 *
 * `--keep-open` is deliberate for every pane-backed member: such a pane must outlive its command so
 * the output can be read, and `prune` is how that stops being a leak. A `bg` member is the one
 * exception — it has no pane to keep open, and `prune` collects its log instead.
 *
 * No pane is required to *drive* the fleet: these verbs work from a T3-hosted or
 * headless agent as long as the Tern daemon answers.
 */
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { capturePane } from "./ctl.ts";
import { resolveAgentCommand } from "./host.ts";
import { runTern, scratchDir } from "./tern.ts";

export interface FleetMember {
	block: number;
	name: string;
	task: string;
	mode: "print" | "interactive" | "command";
	cwd?: string;
	startedAt: string;
	taskFile?: string;
	/** Spawned detached: no pane outlives it, so read/wait/stop go through `logFile` and `pid`. */
	bg?: boolean;
	/** bg: the detached shell's pid, which is also the id of its process group. */
	pid?: number;
	/** bg: where the detached command's stdout and stderr are appended. */
	logFile?: string;
}

interface FleetState {
	members: FleetMember[];
}

function fleetFile(): string {
	return path.join(scratchDir(), "fleet.json");
}

export function loadFleet(): FleetState {
	try {
		const parsed = JSON.parse(readFileSync(fleetFile(), "utf8")) as FleetState;
		return Array.isArray(parsed?.members) ? parsed : { members: [] };
	} catch {
		return { members: [] };
	}
}

export function saveFleet(state: FleetState): FleetState {
	try {
		mkdirSync(scratchDir(), { recursive: true });
		writeFileSync(fleetFile(), `${JSON.stringify(state, null, 2)}\n`, "utf8");
	} catch {
		/* best effort */
	}
	return state;
}

export function forgetMember(block: number): FleetState {
	const state = loadFleet();
	return saveFleet({ members: state.members.filter((member) => member.block !== block) });
}

function safeName(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "task";
}

function shQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Is a detached (`bg`) process still running? `kill(pid, 0)` is the only portable probe: it sends no
 * signal, and EPERM means "alive but not ours", which still counts as running.
 */
export function bgProcessAlive(pid?: number): boolean {
	if (!pid || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Tail of a detached member's log — its whole transcript, since there is no pane to capture. */
function bgTail(member: FleetMember, bytes = 200_000): string {
	if (!member.logFile) return "";
	try {
		const text = readFileSync(member.logFile, "utf8");
		return text.length > bytes ? text.slice(-bytes) : text;
	} catch {
		return "";
	}
}

/** bg bookkeeping lives in the scratch dir; prune is the only thing that removes it. */
function removeBgFiles(member: FleetMember): void {
	for (const file of [member.logFile, member.logFile?.replace(/\.log$/, ".pid"), member.logFile?.replace(/\.log$/, ".sh")]) {
		if (!file) continue;
		try {
			unlinkSync(file);
		} catch {
			/* already gone */
		}
	}
}

function findMember(block: number | string): FleetMember | undefined {
	const id = Number(block);
	return loadFleet().members.find((member) => member.block === id);
}

/** Live blocks, so a member whose pane was closed can be reported as gone. */
export async function liveBlocks(timeoutMs = 15000): Promise<Set<number>> {
	const result = await runTern(["ls", "--json"], timeoutMs);
	const ids = new Set<number>();
	if (result.code !== 0) return ids;
	try {
		const walk = (node: unknown): void => {
			if (Array.isArray(node)) {
				for (const item of node) walk(item);
				return;
			}
			if (!node || typeof node !== "object") return;
			const record = node as Record<string, unknown>;
			if (Array.isArray(record.blocks)) {
				for (const block of record.blocks as Array<{ id?: number }>) {
					if (typeof block?.id === "number") ids.add(block.id);
				}
			}
			for (const value of Object.values(record)) walk(value);
		};
		walk(JSON.parse(result.stdout));
	} catch {
		/* an unparseable listing means "unknown", which reads as not-live */
	}
	return ids;
}

export interface FleetSpawnOptions {
	task: string;
	name?: string;
	cwd?: string;
	/** `print` runs `pi -p "<task>"` (pane exits when done); `interactive` runs a pi TUI. */
	mode?: "print" | "interactive" | "command";
	/** For mode=command: the shell command to run instead of pi. */
	command?: string;
	/** The agent binary for print/interactive modes. */
	agentCommand?: string;
	/** Extra argv for the agent, e.g. ["--model", "opencode-go/deepseek-v4.1-flash"]. */
	agentArgs?: string[];
	worktree?: string;
	keepOpen?: boolean;
	/**
	 * Run detached instead of in a kept pane: `setsid` gives the command its own session, stdout and
	 * stderr go to a log file, and the pane is not kept — so the work survives the pane with no Tern
	 * real estate held. `read` tails the log, `wait` polls the pid, `stop` signals its process group.
	 */
	bg?: boolean;
}

export interface FleetSpawnResult {
	member: FleetMember;
	block: number;
}

/**
 * Spawn a pane. The task text is written to a file and read with `"$(cat …)"`, so
 * no shell quoting can corrupt a task that contains quotes, newlines or `$`.
 */
export async function fleetSpawn(options: FleetSpawnOptions): Promise<FleetSpawnResult> {
	const task = options.task?.trim();
	if (!task) throw new Error("task is required");
	const mode = options.mode ?? "print";
	const name = safeName(options.name ?? task);
	let command: string;
	let taskFile: string | undefined;
	const agent = options.agentCommand ?? resolveAgentCommand().command;
	const extra = (options.agentArgs ?? []).map((arg) => `'${arg.replace(/'/g, `'\\''`)}'`);

	if (mode === "command") {
		if (!options.command?.trim()) throw new Error("mode=command needs a command");
		command = options.command.trim();
	} else if (mode === "interactive") {
		command = [agent, ...extra].join(" ");
	} else {
		mkdirSync(scratchDir(), { recursive: true });
		taskFile = path.join(scratchDir(), `fleet-${name}-${Date.now()}.txt`);
		writeFileSync(taskFile, `${task}\n`, "utf8");
		command = `${[agent, ...extra].join(" ")} -p "$(cat ${JSON.stringify(taskFile)})"`;
	}

	let logFile: string | undefined;
	let pidFile: string | undefined;
	if (options.bg) {
		if (mode === "interactive") {
			throw new Error("bg needs mode print or command: an interactive TUI has nothing to detach");
		}
		mkdirSync(scratchDir(), { recursive: true });
		const stamp = `${name}-${Date.now()}`;
		logFile = path.join(scratchDir(), `fleet-${stamp}.log`);
		pidFile = path.join(scratchDir(), `fleet-${stamp}.pid`);
		const script = path.join(scratchDir(), `fleet-${stamp}.sh`);
		// The wrapper records its own pid (the session and group leader `setsid` creates) so `stop`
		// can signal the whole process group, then runs the real command as its child.
		writeFileSync(script, `#!/bin/sh\necho $$ > ${shQuote(pidFile)}\n${command}\n`, { encoding: "utf8", mode: 0o755 });
		// `setsid --fork` and no trailing `&` on purpose: the pane's shell must stay in the foreground
		// just long enough to open the log (redirection is the shell's own, so the file exists before
		// the child is even exec'd) while the *grandchild* ends up in a new session. A bare `cmd &`
		// loses this race — Tern closes the block the moment the shell exits and reaps the group, so
		// the child is often killed before it can detach or create the log.
		command = `setsid --fork sh ${shQuote(script)} > ${shQuote(logFile)} 2>&1 < /dev/null`;
	}

	const args = ["new", "tab", "--json"];
	// A detached member must not hold a pane: that is the entire point of `bg`.
	if (options.keepOpen !== false && !options.bg) args.push("--keep-open");
	const cwd = options.worktree ?? options.cwd;
	if (cwd) args.push("--cwd", cwd);
	args.push("--", "sh", "-lc", command);
	const created = await runTern(args, 20000);
	if (created.code !== 0) {
		throw new Error(created.stderr.trim() || created.stdout.trim() || `tern new tab exited ${created.code}`);
	}
	let block = 0;
	try {
		block = Number((JSON.parse(created.stdout) as { block?: number }).block ?? 0);
	} catch {
		/* handled below */
	}
	if (!block) throw new Error(`could not read the new pane id: ${created.stdout.slice(0, 200)}`);

	let pid: number | undefined;
	if (options.bg && pidFile) {
		// The wrapper writes the pid within milliseconds; a short poll beats racing the scheduler.
		for (let attempt = 0; attempt < 50 && pid === undefined; attempt += 1) {
			try {
				const value = Number(readFileSync(pidFile, "utf8").trim());
				if (Number.isFinite(value) && value > 0) pid = value;
			} catch {
				/* not written yet */
			}
			if (pid === undefined) await sleep(100);
		}
	}

	const member: FleetMember = {
		block,
		name,
		task,
		mode,
		cwd,
		startedAt: new Date().toISOString(),
		taskFile,
		...(options.bg ? { bg: true, pid, logFile } : {}),
	};
	const state = loadFleet();
	state.members = [...state.members.filter((existing) => existing.block !== block), member];
	saveFleet(state);
	return { member, block };
}

/** Type text into a pane's program, optionally submitting it with Enter. */
export async function fleetSend(
	block: number | string,
	text: string,
	options: { submit?: boolean; paste?: boolean; timeoutMs?: number } = {},
): Promise<string> {
	const verb = options.paste ? "paste" : "text";
	const typed = await runTern(["send", String(block), verb, text], options.timeoutMs ?? 15000);
	if (typed.code !== 0) {
		throw new Error(typed.stderr.trim() || `tern send ${verb} exited ${typed.code}`);
	}
	if (options.submit !== false) {
		const submitted = await runTern(["send", String(block), "keys", "Enter"], 10000);
		if (submitted.code !== 0) {
			throw new Error(submitted.stderr.trim() || `tern send keys exited ${submitted.code}`);
		}
	}
	return `sent ${text.length} chars to block ${block}`;
}

export async function fleetRead(
	block: number | string,
	flags: { scrollback?: boolean; ansi?: boolean } = {},
): Promise<string> {
	// A detached member has no pane to capture; its log file is the transcript.
	const member = findMember(block);
	if (member?.bg) return bgTail(member);
	return capturePane(String(block), { scrollback: flags.scrollback !== false, ansi: flags.ansi === true });
}

export interface FleetWaitResult {
	exited: boolean;
	timedOut: boolean;
	output: string;
}

export async function fleetWait(
	block: number | string,
	timeoutSeconds = 300,
): Promise<FleetWaitResult> {
	const member = findMember(block);
	if (member?.bg) {
		const deadline = Date.now() + Math.max(1, timeoutSeconds) * 1000;
		let alive = bgProcessAlive(member.pid);
		while (alive && Date.now() < deadline) {
			await sleep(250);
			alive = bgProcessAlive(member.pid);
		}
		return { exited: !alive, timedOut: alive, output: bgTail(member) };
	}
	const waited = await runTern(
		["wait", String(block), "--until", "exit", "--timeout", String(Math.max(1, timeoutSeconds))],
		(timeoutSeconds + 15) * 1000,
	);
	let output = "";
	try {
		output = await fleetRead(block);
	} catch {
		output = "";
	}
	return { exited: waited.code === 0, timedOut: waited.timedOut, output };
}

export async function fleetStop(block: number | string, options: { close?: boolean } = {}): Promise<string> {
	const member = findMember(block);
	if (member?.bg) {
		let signal = "no live process";
		if (bgProcessAlive(member.pid)) {
			try {
				// Negative pid targets the whole group, so a shell's children go too.
				process.kill(-Number(member.pid), "SIGTERM");
				signal = "SIGTERM to its process group";
			} catch {
				try {
					process.kill(Number(member.pid), "SIGTERM");
					signal = "SIGTERM to the process";
				} catch {
					/* exited between the probe and the signal */
				}
			}
		}
		// The pane is normally already gone; closing it is a no-op when it is.
		if (options.close !== false) await runTern(["close", String(block)], 15000).catch(() => undefined);
		forgetMember(Number(block));
		return `detached ${member.pid ?? "?"}: ${signal} · no pane kept`;
	}
	const killed = await runTern(["kill", String(block)], 15000);
	if (killed.code !== 0 && !options.close) {
		// A finished command has no live process; removing the block is still valid.
	}
	let closed = "block kept";
	if (options.close !== false) {
		const closedResult = await runTern(["close", String(block)], 15000);
		closed = closedResult.code === 0 ? "block closed" : "block already gone";
	}
	forgetMember(Number(block));
	return `killed (${killed.code === 0 ? "signal sent" : "no live process"}) · ${closed}`;
}

/**
 * How long a dead fleet pane may linger before `prune` will close it.
 *
 * `--keep-open` is unconditional because a spawned agent pane must not vanish the moment its command
 * exits: you want to read what it printed, and a `pi -p` task that finished in 3 seconds should not
 * take its output with it. The cost is that panes accumulate for the lifetime of the Tern daemon,
 * which survives app updates by design — so a leak that only a daemon restart clears.
 *
 * Hence a real cleanup path, with a floor that respects the reason above.
 */
export const FLEET_PANES_KEEP_OPEN = true;

/** Default minimum age before a dead pane is eligible for pruning: 30 minutes. */
export const DEFAULT_PRUNE_MIN_AGE_MS = 30 * 60_000;

export interface PruneResult {
	/** Blocks closed, with the reason each was eligible. */
	pruned: { block: number; name: string; ageMinutes: number; reason: string }[];
	/** Panes left alone, with why — so a prune never looks like it silently ignored something. */
	kept: { block: number; name: string; reason: string }[];
}

/**
 * Close fleet panes whose command has exited and that nothing else has claimed.
 *
 * Deliberately conservative, because closing the wrong pane destroys work the user can see:
 *
 *  - only panes this fleet recorded (never a pane the user opened themselves);
 *  - only panes whose process is gone (a live one is somebody's active session);
 *  - only panes idle for longer than `minAgeMs`;
 *  - never the pane the caller is running in, and never a pane with a live agent program.
 *
 * `dryRun` reports what would go without touching anything.
 */
export async function fleetPrune(
	options: {
		minAgeMs?: number;
		dryRun?: boolean;
		protect?: number[];
		/**
		 * Which blocks are live. Defaults to asking the daemon. Injectable so the guards can be
		 * tested without a Tern, and so a test can never accidentally close a real pane.
		 */
		live?: () => Promise<Set<number>>;
	} = {},
): Promise<PruneResult> {
	const minAgeMs = options.minAgeMs ?? DEFAULT_PRUNE_MIN_AGE_MS;
	const state = loadFleet();
	const live = await (options.live ?? liveBlocks)();
	const protectedBlocks = new Set(options.protect ?? []);
	if (process.env.TERN_PANE) protectedBlocks.add(Number(process.env.TERN_PANE));

	const result: PruneResult = { pruned: [], kept: [] };
	const survivors: FleetMember[] = [];

	for (const member of state.members) {
		const ageMs = Date.now() - (Date.parse(member.startedAt) || Date.now());
		const ageMinutes = Math.round(ageMs / 60_000);
		const keep = (reason: string): void => {
			result.kept.push({ block: member.block, name: member.name, reason });
			survivors.push(member);
		};

		if (protectedBlocks.has(member.block)) {
			keep("protected: this is the pane you are running in");
			continue;
		}
		if (member.bg) {
			// Detached members are judged by their pid: there is no pane to leave open, and holding
			// their record would only leak a log file.
			if (bgProcessAlive(member.pid)) {
				keep("live: its detached process is still running");
				continue;
			}
			if (ageMs < minAgeMs) {
				keep(`too young: ${ageMinutes}m old, needs ${Math.round(minAgeMs / 60_000)}m`);
				continue;
			}
			if (!options.dryRun) {
				forgetMember(member.block);
				removeBgFiles(member);
			}
			result.pruned.push({
				block: member.block,
				name: member.name,
				ageMinutes,
				reason: `detached process exited ${ageMinutes}m ago, over the ${Math.round(minAgeMs / 60_000)}m idle floor`,
			});
			continue;
		}
		if (live.has(member.block)) {
			// Still running. A long build or a dev server is exactly what keep-open is for.
			keep("live: its command is still running");
			continue;
		}
		if (ageMs < minAgeMs) {
			keep(`too young: ${ageMinutes}m old, needs ${Math.round(minAgeMs / 60_000)}m`);
			continue;
		}
		if (!options.dryRun) {
			// The pane is dead and old; closing it is the whole point. `close` is safe on a block
			// that already exited, and forgetting it is local bookkeeping either way.
			await runTern(["close", String(member.block)], 15000).catch(() => undefined);
			forgetMember(member.block);
		}
		result.pruned.push({
			block: member.block,
			name: member.name,
			ageMinutes,
			reason: `exited ${ageMinutes}m ago, over the ${Math.round(minAgeMs / 60_000)}m idle floor`,
		});
	}

	// `forgetMember` already rewrote the state file per pruned member, and a dry run must not
	// rewrite it at all, so there is nothing to reconcile here. Assert it rather than guess: if the
	// recorded set and the survivors disagree, the bookkeeping is wrong and says so.
	if (!options.dryRun && result.pruned.length > 0) {
		const recorded = new Set(loadFleet().members.map((member) => member.block));
		for (const survivor of survivors) {
			if (!recorded.has(survivor.block)) {
				throw new Error(`fleet prune lost block ${survivor.block} (${survivor.name}) from the state file`);
			}
		}
	}
	return result;
}

export interface FleetStatus extends FleetMember {
	live: boolean;
	tail?: string;
}

/** Enrich the recorded members with liveness and a short tail of their output. */
export async function fleetStatus(options: { read?: boolean; tailLines?: number } = {}): Promise<FleetStatus[]> {
	const state = loadFleet();
	const live = await liveBlocks();
	const out: FleetStatus[] = [];
	for (const member of state.members) {
		// A detached member's pane is expected to be gone; its pid says whether it is alive.
		const entry: FleetStatus = { ...member, live: member.bg ? bgProcessAlive(member.pid) : live.has(member.block) };
		if (options.read && member.bg) {
			const text = bgTail(member);
			const lines = text.split("\n").filter((line) => line.trim());
			entry.tail = lines.slice(-(options.tailLines ?? 6)).join("\n");
		}
		if (options.read && !member.bg && entry.live) {
			try {
				const text = await fleetRead(member.block);
				const lines = text.split("\n").filter((line) => line.trim());
				entry.tail = lines.slice(-(options.tailLines ?? 6)).join("\n");
			} catch {
				/* leave the tail empty */
			}
		}
		out.push(entry);
	}
	return out;
}
