/**
 * The TSP handshake is a race, so it is tested as one.
 *
 * Measured on identical panes: `scripts/hello-probe.mjs` received Tern's 633-byte reply
 * immediately, while `scripts/tsp-render.mjs` received **nothing across six retries over 2.4 s**.
 * The launcher made a single 700 ms attempt and fell back to stock pi silently, so native mode
 * engaged nondeterministically and nothing recorded why.
 *
 * These drive the real `probe()` with fake streams that answer on a chosen attempt, so the
 * behaviour is deterministic and needs no Tern, no pty and no model.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	clearProbeFailure,
	handshakePossible,
	ProbeReason,
	probe,
	recordProbeFailure,
	type ProbeEnv,
	type ProbeInput,
	type ProbeOutput,
} from "../native/handshake.mjs";
import { encodeMessage } from "../native/tsp.mjs";

// The reply shape is Tern's own, from a captured handshake (evidence note tern-tsp-hello-0.4.5):
//   ESC _ tsp;r;{"r":"hello","v":1,"term":"tern","ver":"0.4.5","kinds":[...44...],"features":[...10...],
//              "apc":65536,"credits":2,"cols":80,"cell":{"w":1,"h":1},"dark":true,"reduceMotion":false} ESC \.
//
// Note `v` is a scalar 1 in the *reply*, while the hello we *send* carries `v: [1]`. A fixture that
// gets that backwards makes `isHelloReply` look broken when it is correct.
const HELLO = {
	r: "hello",
	v: 1,
	term: "tern",
	app: "tern",
	ver: "0.5.1",
	kinds: ["col", "rows", "md", "image", "chart"],
	features: ["dock", "aside"],
	credits: 2,
};
const helloFrame = () => `${encodeMessage("r", HELLO)}\x1b[?62;52;c`;

type DataHandler = (chunk: Buffer | string) => void;

/** An input stream that records raw-mode transitions and lets a test push bytes at it. */
function fakeInput({ isTTY = true, rawFails = false } = {}): ProbeInput & {
	rawModeCalls: boolean[];
	push(text: string): void;
	readonly listenerCount: number;
} {
	const listeners = new Set<DataHandler>();
	const rawModeCalls: boolean[] = [];
	const stream = {
		isTTY,
		isRaw: false,
		rawModeCalls,
		setRawMode(value: boolean) {
			rawModeCalls.push(value);
			if (rawFails) throw new Error("ENOTTY: not a terminal");
			this.isRaw = value;
		},
		on(event: string, handler: DataHandler) {
			if (event === "data") listeners.add(handler);
		},
		off(event: string, handler: DataHandler) {
			if (event === "data") listeners.delete(handler);
		},
		resume() {},
		pause() {},
		push(text: string) {
			for (const handler of listeners) handler(Buffer.from(text, "utf8"));
		},
		get listenerCount() {
			return listeners.size;
		},
	};
	return stream;
}

/** An output stream that records the frames written to it. */
function fakeOutput(): ProbeOutput & {
	written: string[];
	readonly helloFrames: number;
	readonly hasDa1: boolean;
} {
	const written: string[] = [];
	return {
		written,
		write(text: string) {
			written.push(String(text));
			return true;
		},
		get helloFrames() {
			return written.filter((chunk) => chunk.includes('"hello"')).length;
		},
		get hasDa1() {
			return written.some((chunk) => chunk.includes("\x1b[c"));
		},
	};
}

const IN_TERN: ProbeEnv = { TERM_PROGRAM: "tern" };

test("a reply on the first attempt succeeds without wasting retries", async () => {
	const input = fakeInput();
	const output = fakeOutput();
	const promise = probe({ input, output, attempts: 3, timeoutMs: 500, env: IN_TERN });
	// Let the first frame go out, then answer it.
	await new Promise((resolve) => setImmediate(resolve));
	input.push(helloFrame());
	const result = await promise;
	assert.equal(result.attempts, 1);
	assert.equal(result.reason, null);
	assert.deepEqual(result.hello?.kinds, HELLO.kinds);
	assert.equal(output.helloFrames, 1, "one attempt means one hello");
});

test("an unanswered handshake is retried, and a late reply still succeeds", async () => {
	const input = fakeInput();
	const output = fakeOutput();
	const promise = probe({ input, output, attempts: 3, timeoutMs: 40, env: IN_TERN });
	// Answer only on the third attempt.
	let seen = 0;
	const poll = setInterval(() => {
		seen = output.helloFrames;
		if (seen >= 3) {
			clearInterval(poll);
			input.push(helloFrame());
		}
	}, 5);
	const result = await promise;
	clearInterval(poll);
	assert.equal(result.attempts, 3, "it took three attempts");
	assert.equal(result.reason, null, "and still succeeded");
	assert.ok(result.hello, "the late reply is used, not discarded");
});

test("every attempt failing reports timeout, not silence", async () => {
	const input = fakeInput();
	const output = fakeOutput();
	const result = await probe({ input, output, attempts: 3, timeoutMs: 20, env: IN_TERN });
	assert.equal(result.hello, null);
	assert.equal(result.reason, ProbeReason.timeout);
	assert.equal(result.attempts, 3);
	assert.equal(output.helloFrames, 3, "all three attempts were actually made");
});

test("a reply that is not a hello is distinguished from no reply at all", async () => {
	// These need different fixes: silence is a race, a wrong answer is a version mismatch.
	const input = fakeInput();
	const output = fakeOutput();
	const promise = probe({ input, output, attempts: 2, timeoutMs: 5000, env: IN_TERN });
	await new Promise((resolve) => setImmediate(resolve));
	input.push("\x1b[?62;52;c"); // DA1 answer, but no hello — the signature of a non-TSP version
	const result = await promise;
	assert.equal(result.hello, null);
	assert.equal(result.reason, `${ProbeReason.noHelloReply}:da1-only`);
	assert.equal(result.attempts, 1, "and it does not retry, because retrying cannot make a terminal speak TSP");
});

test("an incomplete TSP frame is never mistaken for junk", async () => {
	// The first read of a split reply cannot contain a complete message. Treating that as junk
	// would reject a good reply — the exact failure the retry loop exists to prevent. This asserts
	// the prefix check, not a completion check.
	const input = fakeInput();
	const output = fakeOutput();
	const started = probe({ input, output, attempts: 1, timeoutMs: 60, env: IN_TERN });
	await new Promise((resolve) => setImmediate(resolve));
	input.push("\x1b_tsp;r;{"); // a partial frame: prefix present, message incomplete
	const result = await started;
	assert.equal(result.reason, ProbeReason.timeout, "it waits for the rest rather than rejecting it");
	assert.notEqual(result.reason, `${ProbeReason.unexpectedReply}:`);
});

test("a split reply across two reads is still parsed", async () => {
	// Tern's reply is 633 bytes and can arrive in pieces; the old single read would drop it.
	const input = fakeInput();
	const output = fakeOutput();
	const promise = probe({ input, output, attempts: 2, timeoutMs: 500, env: IN_TERN });
	await new Promise((resolve) => setImmediate(resolve));
	const frame = helloFrame();
	const cut = Math.floor(frame.length / 2);
	input.push(frame.slice(0, cut));
	input.push(frame.slice(cut));
	const result = await promise;
	assert.ok(result.hello, "the halves reassemble into a hello");
	assert.equal(result.hello?.ver, "0.5.1");
});

test("raw mode is set on and restored, and its failure is reported", async () => {
	const input = fakeInput();
	const output = fakeOutput();
	const promise = probe({ input, output, attempts: 1, timeoutMs: 300, env: IN_TERN });
	await new Promise((resolve) => setImmediate(resolve));
	input.push(helloFrame());
	await promise;
	assert.deepEqual(input.rawModeCalls, [true, false], "set for the probe, then restored");

	// Without raw mode the reply would sit in the line buffer and only echo to the screen.
	const broken = fakeInput({ rawFails: true });
	const result = await probe({ input: broken, output: fakeOutput(), attempts: 2, timeoutMs: 50, env: IN_TERN });
	assert.match(String(result.reason), /^no-raw-mode:/);
});

test("the handshake is skipped, with a reason, where it cannot work", async () => {
	assert.deepEqual(handshakePossible({ TERM_PROGRAM: "tern" }), { ok: true, reason: null });
	assert.deepEqual(handshakePossible({ TERM_PROGRAM: "xterm" }), { ok: false, reason: ProbeReason.notInteractive });
	// tmux/screen/zellij swallow APC strings, so the handshake cannot complete at all.
	assert.deepEqual(handshakePossible({ TERM_PROGRAM: "tern", TMUX: "/tmp/t" }), {
		ok: false,
		reason: ProbeReason.multiplexer,
	});

	for (const [env, reason] of [
		[{ TERM_PROGRAM: "xterm" }, ProbeReason.notInteractive],
		[{ TERM_PROGRAM: "tern", TMUX: "/tmp/t" }, ProbeReason.multiplexer],
		[{ TERM_PROGRAM: "tern", PI_TERN_DISABLE_NATIVE: "1" }, ProbeReason.disabled],
	] satisfies [ProbeEnv, string][]) {
		const result = await probe({ input: fakeInput(), output: fakeOutput(), env, attempts: 3, timeoutMs: 50 });
		assert.equal(result.reason, reason, `env ${JSON.stringify(env)}`);
		assert.equal(result.attempts, 0, "and no attempt is wasted on a case that cannot succeed");
	}
});

test("PI_TERN_NATIVE_BLOCK=force skips the handshake without pretending it succeeded", async () => {
	const output = fakeOutput();
	const result = await probe({
		input: fakeInput(),
		output,
		env: { TERM_PROGRAM: "tern", PI_TERN_NATIVE_BLOCK: "force" },
		attempts: 3,
		timeoutMs: 50,
	});
	assert.equal(result.hello?.forced, true);
	assert.equal(output.helloFrames, 0, "no handshake was attempted");
});

test("the failure reason is recorded and then cleared", () => {
	// This is what makes "native mode did not engage" diagnosable instead of a shrug.
	const dir = mkdtempSync(path.join(os.tmpdir(), "pi-tern-probe-"));
	const file = path.join(dir, "state.json");
	try {
		recordProbeFailure(file, `${ProbeReason.unexpectedReply}:"junk"`, 3);
		const recorded = JSON.parse(readFileSync(file, "utf8"));
		assert.equal(recorded.probeFailure.reason.startsWith("unexpected-reply"), true);
		assert.equal(recorded.probeFailure.attempts, 3);
		assert.ok(recorded.probeFailure.at > 0, "and it is timestamped");

		clearProbeFailure(file);
		const cleared = JSON.parse(readFileSync(file, "utf8"));
		assert.equal(cleared.probeFailure, undefined, "a stale failure must not outlive the success");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("recording a failure never throws, even with no writable state file", () => {
	assert.doesNotThrow(() => recordProbeFailure("/nonexistent-dir/state.json", ProbeReason.timeout, 3));
	assert.doesNotThrow(() => clearProbeFailure("/nonexistent-dir/state.json"));
});

test("the input listener is removed once the probe finishes", async () => {
	// A listener left attached keeps the process alive and keeps reading pi's keystrokes.
	const input = fakeInput();
	const output = fakeOutput();
	const promise = probe({ input, output, attempts: 1, timeoutMs: 300, env: IN_TERN });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(input.listenerCount, 1);
	input.push(helloFrame());
	await promise;
	assert.equal(input.listenerCount, 0, "no listener is left behind");
});
