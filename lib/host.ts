/**
 * Which agent binary a spawned pane should run.
 *
 * pi-tern started life targeting stock Pi, and every place that spawns an agent hard-coded the
 * name `pi`. That is wrong on a machine whose host is **pi-bolt**: same package
 * (`@earendil-works/pi-coding-agent`), same version, different executable name — so `tern_fleet`
 * would open panes running `pi: command not found` while `/tern doctor` reported everything green.
 * On this machine `pi` and `pi-bolt` are in fact the same binary, which is exactly why the guess
 * has to be resolved from evidence rather than assumed.
 *
 * Resolution order, each step an explicit override of the one after it:
 *
 *   1. `PI_TERN_AGENT`      — the user's word, used verbatim (it may be `omp`, or a path).
 *   2. `PI_TERN_LAUNCHER`   — pi-tern's own launcher, set when this session was started through it,
 *                             so a fleet member is the same agent, inside the same terminal, as the
 *                             session that spawned it.
 *   3. `pi` on PATH         — stock Pi, the historical default.
 *   4. `pi-bolt` on PATH    — the bolt build, additive: stock Pi is still preferred when both exist.
 *   5. `pi`                 — nothing found; let the shell produce its own error rather than
 *                             silently running a different agent.
 *
 * Pure and injected (`env`, `exists`, `pathDirs`) so the order is testable without a host install.
 */
import { existsSync } from "node:fs";
import path from "node:path";

export interface AgentResolution {
	/** What to run: a bare name resolved through PATH, or an absolute path. */
	command: string;
	source: "env" | "launcher" | "path" | "default";
	/** The names looked for on PATH, in order — reported so a wrong guess is diagnosable. */
	looked: string[];
}

export interface AgentResolveOptions {
	env?: NodeJS.ProcessEnv;
	exists?: (candidate: string) => boolean;
	pathDirs?: string[];
}

/** The executables that serve the same `@earendil-works/pi-coding-agent` package, in preference order. */
export const AGENT_BINARIES = ["pi", "pi-bolt"] as const;

export function resolveAgentCommand(options: AgentResolveOptions = {}): AgentResolution {
	const env = options.env ?? process.env;
	const exists = options.exists ?? existsSync;
	const pathDirs = options.pathDirs ?? (env.PATH ?? "").split(path.delimiter);

	const explicit = env.PI_TERN_AGENT?.trim();
	if (explicit) return { command: explicit, source: "env", looked: [] };

	const launcher = env.PI_TERN_LAUNCHER?.trim();
	if (launcher) return { command: launcher, source: "launcher", looked: [] };

	const looked: string[] = [];
	for (const name of AGENT_BINARIES) {
		looked.push(name);
		for (const dir of pathDirs) {
			if (!dir) continue;
			if (exists(path.join(dir, name))) return { command: name, source: "path", looked };
		}
	}
	return { command: AGENT_BINARIES[0], source: "default", looked };
}
