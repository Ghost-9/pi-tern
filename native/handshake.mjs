/**
 * The TSP handshake: send `hello` + DA1, read Tern's reply, and say *why* when it does not arrive.
 *
 * This is protocol logic, not launcher bootstrap, so it lives in its own module: the launcher is a
 * top-level script whose whole purpose is to be invisible outside Tern, which makes it awkward to
 * drive from a test (going native means spawning pi, and not going native means spawning stock pi —
 * neither is observable without side effects). Here the seam is a function, and the race can be
 * reproduced deterministically with a fake stream.
 *
 * The race is real and measured. On identical panes, `scripts/hello-probe.mjs` received Tern's
 * 633-byte reply immediately while `scripts/tsp-render.mjs` received **nothing across six retries
 * over 2.4 s**. A single 700 ms attempt therefore fails nondeterministically.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { encodeHello, extractMessages, isHelloReply, TSP_PREFIX } from "./tsp.mjs";

/** Why a handshake did not produce a hello. Distinguishing these is the point. */
export const ProbeReason = {
	/** Nothing arrived at all within the timeout. */
	timeout: "timeout",
	/** Bytes arrived but were not a hello reply — usually a version or protocol mismatch. */
	unexpectedReply: "unexpected-reply",
	/** The terminal answered our DA1 sentinel but said nothing about TSP: it does not speak it. */
	noHelloReply: "no-hello-reply",
	/** stdin refused raw mode, so the reply can never be read: it stays in the line buffer. */
	noRawMode: "no-raw-mode",
	/** Raw mode is on but stdin is not a tty we can read from. */
	notInteractive: "not-interactive",
	/** Deliberately switched off. */
	disabled: "disabled",
	/** A multiplexer swallows APC strings, so the handshake cannot complete. */
	multiplexer: "multiplexer",
};

/** A lone DA1 answer: `ESC [ ? <params> c`, with nothing before or after it. */
const DA1_REPLY = /^\x1b\[\?[0-9;]*c$/;

/** True when the process is inside Tern and not behind a multiplexer that eats APC strings. */
export function handshakePossible(env = process.env) {
	if ((env.TERM_PROGRAM ?? "").toLowerCase() !== "tern") return { ok: false, reason: ProbeReason.notInteractive };
	if (env.TMUX || env.STY || env.ZELLIJ) return { ok: false, reason: ProbeReason.multiplexer };
	return { ok: true, reason: null };
}

/**
 * One attempt.
 *
 * `input`/`output` default to the process streams so the launcher can call this with no arguments,
 * and a test can pass fakes. Raw mode is mandatory: in canonical mode the reply sits in the line
 * buffer and only echoes to the screen, so a program that skips it never sees the reply at all.
 */
export function probeOnce({ input = process.stdin, output = process.stdout, timeoutMs = 700 } = {}) {
	return new Promise((resolve) => {
		const wasRaw = input.isRaw;
		let buffer = "";
		let settled = false;

		const finish = (hello, reason) => {
			if (settled) return;
			settled = true;
			input.off?.("data", onData);
			try {
				if (typeof input.setRawMode === "function") input.setRawMode(Boolean(wasRaw));
			} catch {
				/* restoring raw mode is best effort */
			}
			input.pause?.();
			clearTimeout(timer);
			resolve({ hello, reason });
		};

		const onData = (chunk) => {
			buffer += String(chunk);
			const { messages } = extractMessages(buffer);
			const hello = messages.map((message) => (isHelloReply(message) ? message.body : null)).find(Boolean);
			if (hello) {
				finish(hello, null);
				return;
			}
			// Bytes that cannot become a hello are worth naming: silence and a wrong answer need
			// different fixes — the first is a race, the second is a version mismatch.
			//
			// The test is "does this look like the start of a TSP frame at all", NOT "is a message
			// complete". A reply split across two reads has an incomplete buffer on the first read,
			// and treating that as junk would reject a perfectly good 633-byte reply — the exact
			// failure this retry loop exists to prevent.
			if (buffer.length > 0 && !buffer.startsWith(TSP_PREFIX)) {
				// A bare DA1 answer is the signature of a terminal that answered our sentinel but
				// said nothing about TSP. Retrying cannot help — the other end does not speak the
				// protocol — so name it now instead of burning the remaining attempts.
				if (DA1_REPLY.test(buffer)) {
					finish(null, `${ProbeReason.noHelloReply}:da1-only`);
					return;
				}
				finish(null, `${ProbeReason.unexpectedReply}:${JSON.stringify(buffer.slice(0, 40))}`);
			}
		};

		if (typeof input.setRawMode !== "function" || input.isTTY === false) {
			resolve({ hello: null, reason: ProbeReason.notInteractive });
			return;
		}
		try {
			input.setRawMode(true);
		} catch (error) {
			resolve({ hello: null, reason: `${ProbeReason.noRawMode}:${error.message}` });
			return;
		}

		input.resume?.();
		input.on("data", onData);
		output.write(encodeHello());
		// DA1 sentinel: Tern answers the hello *before* this reply, so seeing DA1 without a hello
		// is the signature of a version that does not speak TSP.
		output.write("\x1b[c");

		const timer = setTimeout(() => finish(null, ProbeReason.timeout), timeoutMs);
	});
}

/**
 * Retry the handshake, because it is a race.
 *
 * Attempts are linear backoff, the first success wins, and the failure reason is returned rather
 * than discarded — the previous single-attempt code fell back to stock pi silently, so the only
 * symptom was that native mode sometimes did not engage.
 */
export async function probe({
	input = process.stdin,
	output = process.stdout,
	attempts,
	timeoutMs,
	backoffMs = 120,
	env = process.env,
	onAttempt,
} = {}) {
	const possible = handshakePossible(env);
	if (!possible.ok) return { hello: null, reason: possible.reason, attempts: 0 };
	if (env.PI_TERN_DISABLE_NATIVE === "1") return { hello: null, reason: ProbeReason.disabled, attempts: 0 };
	// An explicit force means the operator wants native mode regardless; there is nothing to ask.
	if (env.PI_TERN_NATIVE_BLOCK === "force") return { hello: { forced: true }, reason: null, attempts: 0 };

	const total = attempts ?? (Number(env.PI_TERN_PROBE_ATTEMPTS) || 3);
	const wait = timeoutMs ?? (Number(env.PI_TERN_PROBE_TIMEOUT_MS) || 700);
	let lastReason = ProbeReason.timeout;
	let made = 0;

	for (let attempt = 1; attempt <= total; attempt += 1) {
		const result = await probeOnce({ input, output, timeoutMs: wait });
		made = attempt;
		onAttempt?.(attempt, result);
		if (result.hello) return { ...result, attempts: attempt };
		lastReason = result.reason ?? ProbeReason.timeout;
		// Only these two are worth retrying. The first is a race, so another attempt can win. The
		// second means stdin is not usable at all, so it cannot. Anything else — a terminal that
		// answered our sentinel with no hello, or junk — is a property of the other end, and
		// retrying only overwrites a precise diagnosis with a generic timeout.
		const retryable = lastReason === ProbeReason.timeout || lastReason.startsWith(ProbeReason.unexpectedReply);
		if (!retryable) break;
		if (attempt < total) await new Promise((resolve) => setTimeout(resolve, backoffMs * attempt));
	}
	// `made`, not `total`: breaking early on an unretryable reason must not be reported as though
	// every attempt ran, or a diagnose reading "3 attempts" implies a race that did not happen.
	return { hello: null, reason: lastReason, attempts: made };
}

/**
 * Record why the handshake failed, so "native mode did not engage" is answerable later.
 *
 * Best effort throughout: an unwritable scratch directory must never stop pi from starting.
 */
export function recordProbeFailure(stateFile, reason, attempts) {
	try {
		let state = {};
		try {
			state = JSON.parse(readFileSync(stateFile, "utf8"));
		} catch {
			/* start fresh */
		}
		state.probeFailure = { reason: String(reason).slice(0, 160), attempts, at: Date.now() };
		writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
	} catch {
		/* best effort */
	}
}

/** Clear a recorded failure once the handshake succeeds, so diagnose does not report a stale one. */
export function clearProbeFailure(stateFile) {
	try {
		const state = JSON.parse(readFileSync(stateFile, "utf8"));
		if (!state.probeFailure) return;
		delete state.probeFailure;
		writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
	} catch {
		/* best effort */
	}
}
