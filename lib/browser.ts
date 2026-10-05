/**
 * Tern browser operations: daemon relay first, `tern browser` CLI fallback.
 * Both drive Tern's built-in WKWebView picture-in-picture — no Chrome needed.
 */
import { browserRelayAvailable, relayBrowser } from "./relay.ts";
import { runTern, type TernEnv } from "./tern.ts";

export interface BrowserAnswer {
	ok?: unknown;
	error?: { kind?: string; message?: string };
}

const OPEN_OPS = new Set([
	"open",
	"state",
	"goto",
	"nav",
	"events",
	"close",
	"eval",
	"capture",
	"input",
	"snapshot",
	"act",
	"pdf",
	"viewport",
	"scripts",
	"files",
	"allow",
	"insecure",
	"agent",
	"dialog",
]);

export function normalizeBrowserOp(env: TernEnv, raw: Record<string, unknown>): Record<string, unknown> {
	const op = String(raw.op ?? "");
	if (!op) throw new Error("browser op requires an `op` field");
	if (!OPEN_OPS.has(op)) throw new Error(`unsupported browser op: ${op}`);
	const out: Record<string, unknown> = { ...raw, op };
	if (op === "open" && out.owner === undefined && env.paneId) out.owner = Number(env.paneId);
	return out;
}

export async function browserOp(
	env: TernEnv,
	raw: Record<string, unknown>,
	timeoutMs = 20000,
): Promise<BrowserAnswer> {
	const op = normalizeBrowserOp(env, raw);
	if (env.paneSocket && browserRelayAvailable()) {
		try {
			const answer = (await relayBrowser(env.paneSocket, op, timeoutMs)) as BrowserAnswer;
			if (answer && typeof answer === "object" && "error" in answer) {
				const error = (answer as { error?: { kind?: string; message?: string } }).error;
				throw new Error(`tern browser ${op}: ${error?.kind ?? "error"} — ${error?.message ?? ""}`);
			}
			return answer;
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("tern browser ")) throw error;
			/* relay unavailable: fall through to the CLI */
		}
	}
	const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
	const result = await runTern(["browser", JSON.stringify(op), "--timeout", String(seconds)], timeoutMs + 5000);
	if (result.timedOut) throw new Error(`tern browser timed out after ${seconds}s`);
	let parsed: BrowserAnswer;
	try {
		parsed = JSON.parse(result.stdout) as BrowserAnswer;
	} catch {
		throw new Error(result.stderr.trim() || result.stdout.trim() || `tern browser exited ${result.code}`);
	}
	if (parsed.error) {
		throw new Error(`tern browser ${op}: ${parsed.error.kind ?? "error"} — ${parsed.error.message ?? ""}`);
	}
	return parsed;
}
