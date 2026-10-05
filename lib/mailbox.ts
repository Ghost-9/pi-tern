/**
 * Mailbox RPC to the pi-bridge Tern plugin: request.json out, response.json back.
 * The plugin polls every 400 ms, so budget ~1 s per operation.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { bridgeDir } from "./bridge.ts";

export interface MailboxResult {
	ok: boolean;
	result?: unknown;
	error?: string;
	ms: number;
	id: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function mailbox(
	op: string,
	args: Record<string, unknown> = {},
	timeoutMs = 10000,
): Promise<MailboxResult> {
	const dir = bridgeDir();
	mkdirSync(dir, { recursive: true });
	const requestFile = path.join(dir, "request.json");
	const responseFile = path.join(dir, "response.json");
	const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const started = Date.now();
	try {
		rmSync(responseFile, { force: true });
	} catch {
		/* nothing to remove */
	}
	writeFileSync(requestFile, `${JSON.stringify({ id, op, args, at: Date.now() })}\n`, "utf8");
	while (Date.now() - started < timeoutMs) {
		await sleep(120);
		try {
			const parsed = JSON.parse(readFileSync(responseFile, "utf8")) as {
				id?: string;
				ok?: boolean;
				result?: unknown;
				error?: string;
			};
			if (parsed.id === id) {
				try {
					rmSync(responseFile, { force: true });
				} catch {
					/* best effort */
				}
				return { ok: parsed.ok === true, result: parsed.result, error: parsed.error, ms: Date.now() - started, id };
			}
		} catch {
			/* response not written yet */
		}
	}
	try {
		rmSync(requestFile, { force: true });
	} catch {
		/* best effort */
	}
	return {
		ok: false,
		error: "mailbox timeout — is the pi-bridge plugin loaded? (press ctrl+shift+f10 in Tern once, or /tern bridge install)",
		ms: Date.now() - started,
		id,
	};
}
