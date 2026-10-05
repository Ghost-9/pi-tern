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

/** Scratch dir for generated diagrams. */
export function scratchDir(): string {
	const dir = path.join(os.homedir(), ".pi", "agent", "scratch", "pi-tern");
	mkdirSync(dir, { recursive: true });
	return dir;
}

export function assertTern(env: TernEnv, what: string): void {
	if (!env.inTern && process.env.PI_TERN_FORCE !== "1") {
		throw new Error(`${what} needs a Tern pane (TERM_PROGRAM=tern). Set PI_TERN_FORCE=1 to try anyway.`);
	}
}
