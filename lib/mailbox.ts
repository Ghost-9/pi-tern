/**
 * Mailbox RPC to the pi-bridge Tern plugin: request.json out, response.json back.
 * The plugin polls every 250 ms, so budget ~0.3–0.6 s per operation; use mailboxBatch
 * for several operations in one round trip.
 */
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { bridgeDir } from "./bridge.ts";

export const EXPECTED_PLUGIN_VERSION = "0.8.0";

export interface MailboxResult {
	ok: boolean;
	result?: unknown;
	error?: string;
	ms: number;
	id: string;
}

export interface BatchResult {
	ok: boolean;
	results?: Array<{ ok: boolean; result?: unknown; error?: string }>;
	error?: string;
	ms: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function writeRequest(dir: string, id: string, op: string, args: Record<string, unknown>): void {
	const requestFile = path.join(dir, "request.json");
	// Stale-request guard: a request older than 5 s means a dead window answered nothing.
	try {
		const age = Date.now() - statSync(requestFile).mtimeMs;
		if (age > 5000) rmSync(requestFile, { force: true });
	} catch {
		/* no previous request */
	}
	writeFileSync(requestFile, `${JSON.stringify({ id, op, args, at: Date.now() })}\n`, "utf8");
}

async function awaitResponse(
	responseFile: string,
	id: string,
	timeoutMs: number,
): Promise<{ ok: boolean; result?: unknown; error?: string } | null> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		await sleep(60);
		try {
			const parsed = JSON.parse(readFileSync(responseFile, "utf8")) as {
				id?: string;
				ok?: boolean;
				result?: unknown;
				error?: string;
				v?: string;
			};
			if (parsed.id !== id) continue;
			try {
				rmSync(responseFile, { force: true });
			} catch {
				/* best effort */
			}
			if (parsed.v !== EXPECTED_PLUGIN_VERSION) {
				return {
					ok: false,
					error: `pi-bridge plugin v${parsed.v ?? "?"} (expected ${EXPECTED_PLUGIN_VERSION}) — the Tern window still runs old plugin code; restart it (or open a new window) and retry`,
				};
			}
			return { ok: parsed.ok === true, result: parsed.result, error: parsed.error };
		} catch {
			/* response not written yet */
		}
	}
	return null;
}

export async function mailbox(
	op: string,
	args: Record<string, unknown> = {},
	timeoutMs = 10000,
): Promise<MailboxResult> {
	const dir = bridgeDir();
	mkdirSync(dir, { recursive: true });
	const responseFile = path.join(dir, "response.json");
	const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const started = Date.now();
	try {
		rmSync(responseFile, { force: true });
	} catch {
		/* nothing to remove */
	}
	writeRequest(dir, id, op, args);
	const response = await awaitResponse(responseFile, id, timeoutMs);
	if (!response) {
		return {
			ok: false,
			error: "mailbox timeout — is the pi-bridge plugin loaded? (press ctrl+shift+f10 in Tern once, or /tern bridge install)",
			ms: Date.now() - started,
			id,
		};
	}
	return { ...response, ms: Date.now() - started, id };
}

/** Several operations in one mailbox round trip (the plugin runs them sequentially). */
export async function mailboxBatch(
	ops: Array<{ op: string; args?: Record<string, unknown> }>,
	timeoutMs = 30000,
): Promise<BatchResult> {
	const dir = bridgeDir();
	mkdirSync(dir, { recursive: true });
	const responseFile = path.join(dir, "response.json");
	const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const started = Date.now();
	try {
		rmSync(responseFile, { force: true });
	} catch {
		/* nothing to remove */
	}
	writeRequest(dir, id, "batch", { ops });
	const response = await awaitResponse(responseFile, id, timeoutMs);
	if (!response) {
		return { ok: false, error: "mailbox batch timeout — is the pi-bridge plugin loaded?", ms: Date.now() - started };
	}
	const results = (response.result as { results?: Array<{ ok: boolean; result?: unknown; error?: string }> })?.results;
	return { ok: response.ok, results, error: response.error, ms: Date.now() - started };
}
