/**
 * Who is running this pane.
 *
 * Tern 0.9 answers `tern whoami --json` with the identity chain of the pane — how it was reached,
 * which machine it is on, and who the principal is:
 *
 *   {"hops":[{"principal":"batra","method":"local","from":"","host":"Mayanks-MacBook-Pro","user":"batra"}]}
 *
 * and exports the same JSON in `TERN_IDENTITY` to programs that run inside a pane. 0.5.x has
 * neither, which is why pi-tern used to infer "where am I" from `TERM_PROGRAM` and a socket path:
 * an inference that cannot tell a local pane from an SSH one into another host, and says nothing
 * about *who* an agent's side effects belong to.
 *
 * Everything here is optional evidence. A build without `whoami` yields `null` and the callers
 * (`tern_status`, `/tern doctor`, the manifest) say "unknown" instead of inventing an answer.
 */
import { runTern } from "./tern.ts";

export interface IdentityHop {
	/** Who the hop authenticated as, e.g. `batra`. */
	principal: string;
	/** How the hop was made: `local`, and whatever a newer Tern adds (`ssh`, `relay`, …). */
	method: string;
	/** Where the hop came from; empty for a local one. */
	from: string;
	/** The machine the hop lands on. */
	host: string;
	/** The account on that machine. */
	user: string;
	/** Anything this build does not model, kept so a richer chain is visible rather than flattened. */
	extra?: Record<string, unknown>;
}

export interface TernIdentity {
	hops: IdentityHop[];
	/** The last hop's principal: the identity the pane actually runs as. */
	principal?: string;
	host?: string;
	method?: string;
	/** `env` when it came from TERN_IDENTITY (no subprocess), `cli` from `tern whoami --json`. */
	source: "env" | "cli";
}

const KNOWN_HOP_FIELDS = new Set(["principal", "method", "from", "host", "user"]);

/**
 * Read an identity chain out of Tern's JSON: the `whoami` answer, or `TERN_IDENTITY`.
 *
 * Tolerant by design: an unknown `method`, extra per-hop fields, or a hop missing `from`/`user`
 * are all still an identity. What is not an identity is a body without a `hops` array — returning
 * null there is what keeps a stale or unrelated JSON blob from being reported as an attribution.
 */
export function parseIdentity(raw: unknown, source: "env" | "cli" = "cli"): TernIdentity | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const hops = (raw as { hops?: unknown }).hops;
	if (!Array.isArray(hops) || hops.length === 0) return null;
	const parsed: IdentityHop[] = [];
	for (const hop of hops) {
		if (!hop || typeof hop !== "object" || Array.isArray(hop)) continue;
		const record = hop as Record<string, unknown>;
		const text = (value: unknown): string => (typeof value === "string" ? value : "");
		const extra: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(record)) {
			if (!KNOWN_HOP_FIELDS.has(key)) extra[key] = value;
		}
		// A hop with no principal and no host says nothing; skipping it keeps `identity.principal`
		// pointing at something real instead of at "".
		if (text(record.principal) === "" && text(record.host) === "") continue;
		parsed.push({
			principal: text(record.principal),
			method: text(record.method),
			from: text(record.from),
			host: text(record.host),
			user: text(record.user),
			...(Object.keys(extra).length > 0 ? { extra } : {}),
		});
	}
	if (parsed.length === 0) return null;
	const last = parsed[parsed.length - 1];
	const identity: TernIdentity = { hops: parsed, source };
	if (last.principal) identity.principal = last.principal;
	if (last.host) identity.host = last.host;
	if (last.method) identity.method = last.method;
	return identity;
}

/** `TERN_IDENTITY` from the pane's environment, or null. No subprocess, no Tern required. */
export function readIdentityEnv(env: NodeJS.ProcessEnv = process.env): TernIdentity | null {
	const raw = env.TERN_IDENTITY;
	if (!raw) return null;
	try {
		return parseIdentity(JSON.parse(raw) as unknown, "env");
	} catch {
		// A malformed TERN_IDENTITY is not fatal — `tern whoami --json` is still there.
		return null;
	}
}

let identityCache: { at: number; value: TernIdentity | null } | undefined;

/** Ask the CLI. Synchronous evidence beats a guess, but it is a subprocess so it is cached. */
export async function readIdentityCli(timeoutMs = 5000): Promise<TernIdentity | null> {
	const result = await runTern(["whoami", "--json"], timeoutMs);
	if (result.code !== 0 || result.timedOut) return null;
	try {
		return parseIdentity(JSON.parse(result.stdout) as unknown, "cli");
	} catch {
		return null;
	}
}

/**
 * The best identity available: the environment first (free), then the CLI (one process), cached
 * for 30 s so a per-call `tern_status` does not fork a process every time. `refresh` bypasses it.
 */
export async function resolveIdentity(refresh = false): Promise<TernIdentity | null> {
	const fromEnv = readIdentityEnv();
	if (fromEnv) return fromEnv;
	const now = Date.now();
	if (!refresh && identityCache && now - identityCache.at < 30_000) return identityCache.value;
	const value = await readIdentityCli();
	identityCache = { at: now, value };
	return value;
}

/** One line for `/tern doctor`: `batra@Mayanks-MacBook-Pro (local)`. */
export function describeIdentity(identity: TernIdentity | null): string {
	if (!identity) return "unknown (this Tern does not answer `whoami --json`)";
	const last = identity.hops[identity.hops.length - 1];
	const where = [last?.principal, last?.host].filter((part) => Boolean(part)).join("@");
	const via = last?.method ? ` (${last.method}${last.from ? ` from ${last.from}` : ""})` : "";
	const chain = identity.hops.length > 1 ? ` · ${identity.hops.length} hops` : "";
	return `${where || "unnamed"}${via}${chain}`;
}
