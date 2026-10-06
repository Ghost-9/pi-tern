/**
 * Minimal TSP v1 helpers for the native (unbundled) pi launcher.
 * Framing: ESC _ tsp ; <verb> ; <json> ESC \
 */

export const TSP_VERSION = 1;
export const TSP_PREFIX = "\x1b_tsp;";
export const ST = "\x1b\\";

export function encodeMessage(verb, body, params = {}) {
	const parts = Object.entries(params).map(([k, v]) => `${k}=${v}`);
	const head = `${TSP_PREFIX}${verb}${parts.length ? ";" + parts.join(";") : ""}`;
	return `${head};${JSON.stringify(body)}${ST}`;
}

export function encodeHello(app = "pi", ver = "1.0.0-m1", features = ["edit", "undo", "send"]) {
	const body = { q: "hello", v: [TSP_VERSION], app, ver, features };
	return `${encodeMessage("q", body)}\x1b[c`;
}

/** Extract TSP messages from a buffer; returns parsed messages and the rest. */
export function extractMessages(buffer) {
	const messages = [];
	let rest = buffer;
	for (;;) {
		const start = rest.indexOf(TSP_PREFIX);
		if (start === -1) return { messages, rest: "" };
		const end = rest.indexOf(ST, start + TSP_PREFIX.length);
		if (end === -1) return { messages, rest: rest.slice(start) };
		const raw = rest.slice(start, end + ST.length);
		rest = rest.slice(end + ST.length);
		const parsed = parseMessage(raw);
		if (parsed) messages.push(parsed);
	}
}

export function parseMessage(raw) {
	if (!raw.startsWith(TSP_PREFIX) || !raw.endsWith(ST)) return null;
	const inner = raw.slice(TSP_PREFIX.length, -ST.length);
	const sentenceEnd = inner.indexOf(";");
	const verb = sentenceEnd === -1 ? inner : inner.slice(0, sentenceEnd);
	if (verb.length !== 1) return null;
	const jsonStart = inner.indexOf("{", sentenceEnd + 1);
	if (jsonStart === -1) return null;
	try {
		return { verb, body: JSON.parse(inner.slice(jsonStart)) };
	} catch {
		return null;
	}
}

export function isHelloReply(message) {
	return message?.verb === "r" && message.body?.r === "hello" && message.body?.v === TSP_VERSION;
}
