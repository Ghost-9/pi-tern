/**
 * TSP v1 wire helpers (Tern Surface Protocol) — extension-side subset.
 * Framing: ESC _ tsp ; <verb> [; k=v]* ; <body> ESC \
 *
 * ## Why the hello is parsed tolerantly
 *
 * The first version of `asHello` required `hello.v === 1` **and** `Array.isArray(hello.kinds)`.
 * That is a hard equality on a number Tern owns, so a build that answered `v: 2` — or one that
 * dropped `kinds` because the vocabulary moved behind a call — would make `asHello` return null.
 * Detection would then report `absent`, the whole surface/native layer would quietly stand down,
 * and nothing in the UI would say why: the exact "silently degrades" failure this file exists to
 * prevent.
 *
 * Measured against the real builds (see docs/TERN-0.9.md):
 *   Tern 0.4.5 / 0.5.0   v: 1, 44 kinds, 10 features
 *   Tern 0.9.8 (f21d9a3) v: 1, 46 kinds,  9 features (`program-palette` gone, `row`/`media` added),
 *                        plus `hour12` — so the *vocabulary* drifted twice while `v` stayed 1.
 *
 * So: accept any `v >= 1` (a future version is used, not refused, and flagged), normalize
 * `kinds`/`features` into arrays whatever shape they arrive in, keep fields we do not know in
 * `extra` instead of dropping them, and let `negotiateHello` say precisely what is new. Gating
 * helpers treat an *absent* vocabulary as "cannot prove it is missing" rather than "unsupported".
 */
export const TSP_VERSION = 1;

/**
 * The highest reply version this build was written against.
 *
 * Deliberately not a cap: `v` above this is still parsed and still used (see `future`), because a
 * newer Tern is much more likely to add fields than to break `o`/`f`/`add`/`set`. Refusing it
 * would trade a small risk of a wrong frame for a certain loss of every surface.
 */
export const TSP_KNOWN_MAX = 1;

export const TSP_APC_PREFIX = "\x1b_tsp;";
export const ST = "\x1b\\";

/** Node kinds pi-tern knows about, across the builds it has measured. */
export const TERN_KINDS_KNOWN = [
	"col", "row", "rows", "card", "section", "rule", "spacer", "text", "md", "code", "diff",
	"ansi", "math", "image", "media", "kv", "table", "tree", "json", "badge", "kbd", "icon",
	"spinner", "shimmer", "elapsed", "progress", "rate", "list", "item", "tabs", "editor",
	"input", "status", "seg", "overlay", "toast", "picker", "prefs", "tool", "checklist", "agent",
	"chart", "meter", "block", "effort", "el",
] as const;

/** Features pi-tern knows about: 0.5.x's ten and 0.9.8's nine (`program-palette` was removed). */
export const TERN_FEATURES_KNOWN = [
	"blobs", "settle", "adopt", "dock", "program-palette", "reduce-motion", "aside", "scroll",
	"styles", "flow",
] as const;

export interface TspHello {
	/** The TSP version Tern answered with, normalized from a number, `[1]` or `"1"`. */
	v: number;
	/** The version this build speaks: `min(v, TSP_KNOWN_MAX)`. What feature gating is written to. */
	protocol: number;
	/** True when Tern answered with a newer `v` than this build implements. */
	future?: boolean;
	term: string;
	ver?: string;
	kinds: string[];
	features: string[];
	apc: number;
	credits: number;
	cols?: number;
	rows?: number;
	cell?: { w: number; h: number };
	dark?: boolean;
	reduceMotion?: boolean;
	/** Hello fields this build does not model, kept so a newer Tern is visible rather than silent. */
	extra?: Record<string, unknown>;
	/**
	 * Set by pi-tern, not by Tern: true once this hello predates the running daemon.
	 *
	 * Tern 0.5.2 switched the daemon to the new build on the first window attach, so a session open
	 * across an update keeps the vocabulary it saw at `session_start` until it re-probes. Without a
	 * marker, "confirmed" would look equally true of a fresh and a stale vocabulary.
	 */
	stale?: boolean;
}

export interface TspMessage {
	verb: string;
	params: Record<string, string>;
	body: unknown;
	raw: string;
}

/** The outcome of reading a hello: either it is usable, or the reason it is not. */
export interface HelloParse {
	hello: TspHello | null;
	/** Set when `hello` is null. A short, machine-readable tag plus a human clause. */
	problem?: string;
}

/** What a hello says about the vocabulary this build does not know. */
export interface HelloNegotiation {
	version: number;
	protocol: number;
	future: boolean;
	kinds: { total: number; known: number; unknown: string[] };
	features: { total: number; known: number; unknown: string[] };
	/** The handful of capabilities pi-tern actually gates on. */
	supported: { image: boolean; chart: boolean; aside: boolean; blobs: boolean };
}

/** hello query + DA1 sentinel, exactly as the SDK book specifies. */
export function encodeHello(app: string, ver: string, features: string[] = ["edit", "undo", "send"]): string {
	const body = JSON.stringify({ q: "hello", v: [TSP_VERSION], app, ver, features });
	return `${TSP_APC_PREFIX}q;${body}${ST}\x1b[c`;
}

export function isDa1Reply(data: string): boolean {
	return /^\x1b\[\?[0-9;]*c$/.test(data);
}

export function looksLikeTsp(data: string): boolean {
	return data.includes(TSP_APC_PREFIX) || data.startsWith("\x1b_tsp") || data.includes("\x1b]877;tsp;");
}

/**
 * ConPTY (Windows) cannot carry APC on the input side, so Tern sends
 * terminal -> program frames as OSC 877: ESC ] 877 ; tsp;... ESC \ (or BEL).
 * Normalize complete OSC-877 frames to the APC form the parser understands.
 */
export function normalizeOsc877(data: string): string {
	return data.replace(/\x1b\]877;tsp;([\s\S]*?)(?:\x1b\\|\x07)/g, (_match, body: string) => `${TSP_APC_PREFIX}${body}${ST}`);
}

/**
 * Extract every complete TSP message from a buffer. Returns the parsed
 * messages and the unconsumed tail (an incomplete message or foreign input).
 */
export function extractTspMessages(buffer: string): { messages: TspMessage[]; rest: string } {
	const messages: TspMessage[] = [];
	let rest = buffer;
	for (;;) {
		const start = rest.indexOf(TSP_APC_PREFIX);
		if (start === -1) {
			// No message start: return the remainder unchanged; the caller decides
			// whether it is a partial prefix, a terminal reply, or foreign input.
			return { messages, rest };
		}
		const end = rest.indexOf(ST, start + TSP_APC_PREFIX.length);
		if (end === -1) {
			rest = rest.slice(start);
			return { messages, rest };
		}
		const raw = rest.slice(start, end + ST.length);
		const parsed = parseTspMessage(raw);
		if (parsed) messages.push(parsed);
		rest = rest.slice(end + ST.length);
	}
}

export function parseTspMessage(raw: string): TspMessage | null {
	if (!raw.startsWith(TSP_APC_PREFIX) || !raw.endsWith(ST)) return null;
	let payload = raw.slice(TSP_APC_PREFIX.length, -ST.length);
	const verb = payload.slice(0, 1);
	if (!/^[a-z]$/.test(verb)) return null;
	payload = payload.slice(1);
	if (!payload.startsWith(";")) return null;
	payload = payload.slice(1);
	const params: Record<string, string> = {};
	// Parameters are k=v segments each followed by another ';'.
	for (;;) {
		const semi = payload.indexOf(";");
		if (semi === -1) break;
		const segment = payload.slice(0, semi);
		if (!/^[A-Za-z0-9_-]+=[^;]+$/.test(segment)) break;
		const eq = segment.indexOf("=");
		params[segment.slice(0, eq)] = segment.slice(eq + 1);
		payload = payload.slice(semi + 1);
	}
	let body: unknown = payload;
	try {
		body = JSON.parse(payload);
	} catch {
		/* leave as raw text */
	}
	return { verb, params, body, raw };
}

const KNOWN_HELLO_FIELDS = new Set([
	"r", "v", "term", "ver", "kinds", "features", "apc", "credits", "cols", "rows", "cell", "dark", "reduceMotion",
]);

/** A TSP version from `1`, `[1]`, `[1,2]` or `"1"` — the reply uses a scalar, peers may echo arrays. */
function coerceVersion(raw: unknown): number | undefined {
	const fromNumber = (value: unknown): number | undefined => {
		const num = typeof value === "string" ? Number(value) : value;
		if (typeof num !== "number" || !Number.isFinite(num)) return undefined;
		const version = Math.trunc(num);
		return version >= 1 ? version : undefined;
	};
	if (Array.isArray(raw)) {
		const versions = raw.map(fromNumber).filter((value): value is number => value !== undefined);
		return versions.length > 0 ? Math.max(...versions) : undefined;
	}
	return fromNumber(raw);
}

/** `["a","b"]`, `"a,b"` and `"a b"` all mean the same vocabulary list. */
function coerceList(raw: unknown): string[] | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (Array.isArray(raw)) return raw.map(String).map((entry) => entry.trim()).filter((entry) => entry.length > 0);
	if (typeof raw === "string") {
		return raw
			.split(/[\s,]+/)
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0);
	}
	return undefined;
}

function coerceNumber(raw: unknown): number | undefined {
	const num = typeof raw === "string" ? Number(raw) : raw;
	return typeof num === "number" && Number.isFinite(num) ? num : undefined;
}

/**
 * Read a hello reply body into a normalized `TspHello`, or say why it is not one.
 *
 * The checks are deliberately about *shape*, not about matching this build's vocabulary: a Tern
 * that adds kinds, renames a feature or bumps `v` is usable, and `negotiateHello` reports the
 * difference. What is rejected is a reply that carries no evidence of being Tern's hello at all —
 * which is what keeps a malformed frame from being mistaken for a detected terminal.
 */
export function parseHello(body: unknown): HelloParse {
	if (!body || typeof body !== "object" || Array.isArray(body)) return { hello: null, problem: "not-a-hello:body is not an object" };
	const record = body as Record<string, unknown>;
	if (record.r !== "hello") return { hello: null, problem: `not-a-hello:r is ${JSON.stringify(record.r ?? null)}` };

	const version = coerceVersion(record.v);
	if (version === undefined) return { hello: null, problem: "no-version:hello has no TSP version >= 1" };

	const kinds = coerceList(record.kinds);
	const features = coerceList(record.features);
	// A hello with no vocabulary and no term is four bytes of JSON that happens to say "hello".
	if (kinds === undefined && features === undefined && typeof record.term !== "string") {
		return { hello: null, problem: "empty-hello:no kinds, features or term" };
	}

	const cell = record.cell as { w?: unknown; h?: unknown } | undefined;
	const extra: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(record)) {
		if (!KNOWN_HELLO_FIELDS.has(key)) extra[key] = value;
	}

	const hello: TspHello = {
		v: version,
		protocol: Math.min(version, TSP_KNOWN_MAX),
		term: typeof record.term === "string" ? record.term : "tern",
		kinds: kinds ?? [],
		features: features ?? [],
		apc: coerceNumber(record.apc) ?? 0,
		credits: coerceNumber(record.credits) ?? 0,
	};
	if (version > TSP_KNOWN_MAX) hello.future = true;
	if (typeof record.ver === "string") hello.ver = record.ver;
	const cols = coerceNumber(record.cols);
	if (cols !== undefined) hello.cols = cols;
	const rows = coerceNumber(record.rows);
	if (rows !== undefined) hello.rows = rows;
	if (cell && (coerceNumber(cell.w) !== undefined || coerceNumber(cell.h) !== undefined)) {
		hello.cell = { w: coerceNumber(cell.w) ?? 0, h: coerceNumber(cell.h) ?? 0 };
	}
	if (typeof record.dark === "boolean") hello.dark = record.dark;
	if (typeof record.reduceMotion === "boolean") hello.reduceMotion = record.reduceMotion;
	if (Object.keys(extra).length > 0) hello.extra = extra;
	return { hello };
}

/** The hello in a message, or null. Kept as the short form every caller already used. */
export function asHello(msg: TspMessage): TspHello | null {
	return parseHelloMessage(msg).hello;
}

/** The hello in a message, or the reason it is not usable — for the probe and the manifest. */
export function parseHelloMessage(msg: TspMessage): HelloParse {
	if (msg.verb !== "r") return { hello: null, problem: `not-a-reply:verb is ${JSON.stringify(msg.verb)}` };
	return parseHello(msg.body);
}

/** What this hello says beyond the vocabulary this build was written for. */
export function negotiateHello(hello: TspHello): HelloNegotiation {
	const knownKinds = new Set<string>(TERN_KINDS_KNOWN);
	const knownFeatures = new Set<string>(TERN_FEATURES_KNOWN);
	const unknownKinds = hello.kinds.filter((kind) => !knownKinds.has(kind));
	const unknownFeatures = hello.features.filter((feature) => !knownFeatures.has(feature));
	return {
		version: hello.v,
		protocol: hello.protocol,
		future: hello.future === true || hello.v > TSP_KNOWN_MAX,
		kinds: { total: hello.kinds.length, known: hello.kinds.length - unknownKinds.length, unknown: unknownKinds },
		features: {
			total: hello.features.length,
			known: hello.features.length - unknownFeatures.length,
			unknown: unknownFeatures,
		},
		supported: {
			image: supportsKind(hello, "image"),
			chart: supportsKind(hello, "chart"),
			aside: supportsFeature(hello, "aside"),
			blobs: supportsFeature(hello, "blobs"),
		},
	};
}

/**
 * Does this hello advertise `kind`?
 *
 * An empty list means the vocabulary was not advertised, which is *not* evidence that the kind is
 * missing — a newer Tern that moved its vocabulary behind a call must not lose every node kind we
 * can draw. An explicit list that omits the kind is evidence, and reports false.
 */
export function supportsKind(hello: TspHello | null | undefined, kind: string): boolean {
	if (!hello) return false;
	if (hello.kinds.length === 0) return true;
	return hello.kinds.includes(kind);
}

/**
 * Does this hello advertise `feature`? Unlike kinds, an empty list is false here: a feature gate
 * that guesses "yes" would send a frame the build does not understand, and every feature pi-tern
 * gates on has a working fallback (no inline images, no aside sheet).
 */
export function supportsFeature(hello: TspHello | null | undefined, feature: string): boolean {
	if (!hello) return false;
	return hello.features.includes(feature);
}

/** The hello's TSP identity as one line, for `/tern doctor` and bug reports. */
export function describeHello(hello: TspHello): string {
	const negotiation = negotiateHello(hello);
	const parts = [
		`TSP v${hello.v}${negotiation.future ? ` (newer than this build's v${TSP_KNOWN_MAX}; using the v${TSP_KNOWN_MAX} subset)` : ""}`,
		`${hello.kinds.length} kinds`,
		`${hello.features.length} features`,
	];
	if (negotiation.kinds.unknown.length > 0) parts.push(`${negotiation.kinds.unknown.length} unknown kind(s): ${negotiation.kinds.unknown.join(", ")}`);
	if (negotiation.features.unknown.length > 0) parts.push(`unknown feature(s): ${negotiation.features.unknown.join(", ")}`);
	return parts.join(" · ");
}
