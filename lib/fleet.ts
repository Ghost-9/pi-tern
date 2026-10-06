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
 *
 * No pane is required to *drive* the fleet: these verbs work from a T3-hosted or
 * headless agent as long as the Tern daemon answers.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { capturePane } from "./ctl.ts";
import { runTern, scratchDir } from "./tern.ts";

export interface FleetMember {
	block: number;
	name: string;
	task: string;
	mode: "print" | "interactive" | "command";
	cwd?: string;
	startedAt: string;
	taskFile?: string;
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
	const agent = options.agentCommand ?? process.env.PI_TERN_AGENT ?? "pi";
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

	const args = ["new", "tab", "--json"];
	if (options.keepOpen !== false) args.push("--keep-open");
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

	const member: FleetMember = {
		block,
		name,
		task,
		mode,
		cwd,
		startedAt: new Date().toISOString(),
		taskFile,
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
		const entry: FleetStatus = { ...member, live: live.has(member.block) };
		if (options.read && entry.live) {
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
