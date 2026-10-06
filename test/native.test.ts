// Native (unbundled launcher) unit tests: ANSI grid + TSP encoding.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Screen } from "../native/ansi.mjs";
import { splitComposer, splitDock } from "../native/layout.mjs";
import { encodeHello, encodeMessage, extractMessages, isHelloReply } from "../native/tsp.mjs";

test("screen places text and honours cursor moves", () => {
	const screen = new Screen(20, 3);
	screen.write("hello");
	screen.write("\x1b[2;3HX");
	screen.write("\r\nY");
	const lines = screen.lines();
	assert.equal(lines[0], "hello");
	assert.equal(lines[1], "  X");
	assert.equal(lines[2], "Y");
});

test("screen erases and scrolls", () => {
	const screen = new Screen(10, 2);
	screen.write("one\r\ntwo");
	screen.write("\x1b[K");
	screen.write("\r\nthree");
	const lines = screen.lines();
	assert.equal(lines.length, 2);
	assert.equal(lines[0], "two");
	assert.equal(lines[1], "three");
});

test("screen keeps SGR runs and resets", () => {
	const screen = new Screen(20, 1);
	screen.write("\x1b[31mred\x1b[0m end");
	const line = screen.lines()[0];
	assert.match(line, /red/);
	assert.match(line, /end/);
	assert.match(line, /\x1b\[31m/);
});

test("splitDock pins the composer area below the last rule", () => {
	const lines = ["transcript 1", "transcript 2", "──────────────────────────", " > type here", " model · ctx"];
	const { main, dock } = splitDock(lines);
	assert.equal(main.length, 2);
	assert.equal(dock.length, 3);
	assert.match(dock[0], /─+/);
});

test("splitDock falls back to full main when no rule exists", () => {
	const { main, dock } = splitDock(["a", "b", "c"]);
	assert.equal(main.length, 3);
	assert.equal(dock.length, 0);
});

test("splitComposer isolates the composer between its two rules", () => {
	const rule = "─".repeat(30);
	const lines = ["transcript", rule, "> draft text", rule, " model · 12k ctx"];
	const parts = splitComposer(lines);
	assert.ok(parts);
	assert.deepEqual(parts.main, ["transcript"]);
	assert.deepEqual(parts.composer, ["> draft text"]);
	assert.deepEqual(parts.status, [" model · 12k ctx"]);
});

test("splitComposer returns null without two rules", () => {
	assert.equal(splitComposer(["a", "b", "─".repeat(20)]), null);
});

test("native sink applies native edit/undo/send events", async () => {
	const chunks: string[] = [];
	const originalWrite = process.stdout.write;
	(process.stdout as unknown as { write: (chunk: unknown) => boolean }).write = (chunk: unknown) => {
		chunks.push(String(chunk));
		return true;
	};
	try {
		const { createNativeSink } = await import("../native/backend.mjs");
		const editor = {
			text: "",
			cursor: { line: 0, col: 0 },
			submitted: "",
			history: [] as string[],
			state: { cursorLine: 0, cursorCol: 0 },
			getText() {
				return this.text;
			},
			setText(text: string) {
				this.text = text;
			},
			getCursor() {
				return this.cursor;
			},
			setCursorCol(col: number) {
				this.cursor = { line: 0, col };
			},
			undo() {
				this.text = this.text.slice(0, -1);
			},
			addToHistory(text: string) {
				this.history.push(text);
			},
			submitValue() {
				this.submitted = this.text;
				this.text = "";
			},
		};
		const sink = createNativeSink({ hello: { cols: 80, rows: 24 }, surfaceId: "s-test" });
		sink.attachEditor(editor);
		sink.flush();
		const event = (body: unknown) => `\x1b_tsp;e;${JSON.stringify(body)}\x1b\\`;
		const leftover = sink.handleInput(
			`abc${event({ ev: "edit", sf: "s-test", id: "e", from: 0, to: 0, text: "hello", cursor: 5, len: 0 })}`,
		);
		assert.equal(leftover, "abc");
		assert.equal(editor.text, "hello");
		sink.handleInput(event({ ev: "edit", sf: "s-test", id: "e", from: 0, to: 5, text: "hi", cursor: 2, len: 5 }));
		assert.equal(editor.text, "hi");
		sink.handleInput(event({ ev: "send", sf: "s-test", id: "e", text: "run the tests" }));
		assert.equal(editor.submitted, "run the tests");
		assert.deepEqual(editor.history, ["hi"]);
		sink.handleInput(event({ ev: "undo", sf: "s-test", id: "e" }));
		assert.ok(chunks.some((line) => line.includes('"suspend"') === false));
		assert.equal(sink.suspend(), true);
		assert.equal(sink.resume(), true);
		assert.ok(chunks.some((line) => line.includes('"suspend"')), "suspend frame written");
		assert.ok(chunks.some((line) => line.includes('"resume"')), "resume frame written");
	} finally {
		process.stdout.write = originalWrite;
	}
});

test("adopt opens the surface with adopt:true", async () => {
	const chunks: string[] = [];
	const originalWrite = process.stdout.write;
	(process.stdout as unknown as { write: (chunk: unknown) => boolean }).write = (chunk: unknown) => {
		chunks.push(String(chunk));
		return true;
	};
	try {
		const { createNativeSink } = await import("../native/backend.mjs");
		const sink = createNativeSink({ hello: { cols: 80, rows: 24 }, surfaceId: "s-adopt", adopt: true });
		sink.flush();
		assert.ok(chunks.some((line) => line.includes('"adopt":true')), "o carries adopt");
	} finally {
		process.stdout.write = originalWrite;
	}
});

test("tsp hello encodes and parses", () => {
	const raw = encodeHello("pi-test", "1.0.0-m1");
	const { messages } = extractMessages(raw);
	assert.equal(messages.length, 1);
	assert.equal(messages[0].verb, "q");
	assert.equal(messages[0].body.q, "hello");
	assert.equal(messages[0].body.app, "pi-test");
	assert.ok(raw.endsWith("\x1b[c"));
});

test("tsp hello reply detection", () => {
	const reply = encodeMessage("r", { r: "hello", v: 1, term: "tern", kinds: ["rows"], features: [], apc: 65536, credits: 2 });
	const { messages } = extractMessages(reply);
	assert.equal(isHelloReply(messages[0]), true);
	assert.equal(isHelloReply({ verb: "r", body: { r: "hello", v: 2 } }), false);
});
