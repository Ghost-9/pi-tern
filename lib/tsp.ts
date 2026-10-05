/**
 * TSP v1 wire helpers (Tern Surface Protocol) — extension-side subset.
 * Framing: ESC _ tsp ; <verb> [; k=v]* ; <body> ESC \
 */
export const TSP_VERSION = 1;
export const TSP_APC_PREFIX = "\x1b_tsp;";
export const ST = "\x1b\\";

export interface TspHello {
	v: number;
	term: string;
	ver?: string;
	kinds: string[];
	features: string[];
	apc: number;
	credits: number;
	cols?: number;
	cell?: { w: number; h: number };
	dark?: boolean;
	reduceMotion?: boolean;
}

export interface TspMessage {
	verb: string;
	params: Record<string, string>;
	body: unknown;
	raw: string;
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
	return data.includes(TSP_APC_PREFIX) || data.startsWith("\x1b_tsp");
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

export function asHello(msg: TspMessage): TspHello | null {
	if (msg.verb !== "r") return null;
	const body = msg.body as { r?: string } | null;
	if (!body || body.r !== "hello") return null;
	const hello = body as unknown as TspHello;
	if (hello.v !== TSP_VERSION || !Array.isArray(hello.kinds)) return null;
	return hello;
}
