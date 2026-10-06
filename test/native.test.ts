// Native (unbundled launcher) unit tests: ANSI grid + TSP encoding.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Screen } from "../native/ansi.mjs";
import { splitDock } from "../native/layout.mjs";
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
