// Protocol and helper tests. No Tern required; runs anywhere with Node >= 22.6.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { asHello, encodeHello, extractTspMessages } from "../lib/tsp.ts";
import { extractMermaids, messageText, renderMessageMarkdown, summarizeArgs } from "../lib/text.ts";
import { writeDiagram } from "../lib/diagram.ts";

// The exact Tern 0.4.5 reply captured in a live pane (see CHANGELOG 0.1.0).
const HELLO_BODY = JSON.stringify({
	r: "hello",
	v: 1,
	term: "tern",
	ver: "0.4.5",
	kinds: [
		"col", "row", "card", "section", "rule", "spacer", "text", "md", "code", "diff", "ansi",
		"math", "image", "kv", "table", "tree", "badge", "kbd", "icon", "spinner", "shimmer",
		"elapsed", "progress", "rate", "list", "item", "tabs", "editor", "input", "status", "seg",
		"overlay", "toast", "rows", "picker", "prefs", "tool", "checklist", "agent", "chart",
		"meter", "block", "effort", "el",
	],
	features: ["blobs", "settle", "adopt", "dock", "program-palette", "reduce-motion", "aside", "scroll", "styles", "flow"],
	apc: 65536,
	credits: 2,
	cols: 80,
	cell: { w: 1, h: 1 },
	dark: true,
	reduceMotion: false,
});
const RAW_REPLY = `\x1b_tsp;r;${HELLO_BODY}\x1b\\\x1b[?62;52;c`;

test("parses the captured Tern hello reply", () => {
	const parsed = extractTspMessages(RAW_REPLY);
	assert.equal(parsed.messages.length, 1);
	assert.equal(parsed.messages[0].verb, "r");
	const hello = asHello(parsed.messages[0]);
	assert.ok(hello);
	assert.equal(hello.v, 1);
	assert.equal(hello.ver, "0.4.5");
	assert.equal(hello.kinds.length, 44);
	assert.ok(hello.kinds.includes("agent") && hello.kinds.includes("el"));
	assert.ok(hello.features.includes("flow") && hello.features.includes("styles"));
});

test("preserves the DA1 reply that follows the hello", () => {
	assert.ok(extractTspMessages(RAW_REPLY).rest.includes("\x1b[?62;52;c"));
});

test("parses a reply split across reads", () => {
	const half = Math.floor(RAW_REPLY.length / 2);
	let buffer = "";
	const verbs: string[] = [];
	for (const part of [RAW_REPLY.slice(0, half), RAW_REPLY.slice(half)]) {
		buffer += part;
		const out = extractTspMessages(buffer);
		buffer = out.rest;
		verbs.push(...out.messages.map((m) => m.verb));
	}
	assert.deepEqual(verbs, ["r"]);
});

test("encodeHello round-trips and ends with the DA1 sentinel", () => {
	const out = extractTspMessages(encodeHello("pi-test", "0.0.1"));
	assert.equal(out.messages[0]?.verb, "q");
	assert.equal((out.messages[0]?.body as { q?: string })?.q, "hello");
	assert.ok(out.rest.includes("\x1b[c"));
});

test("extracts mermaid fences from prose", () => {
	const text = "Here:\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\nand\n\n```mermaid\ngraph TD\n  X --> Y\n```\n";
	const found = extractMermaids(text);
	assert.equal(found.length, 2);
	assert.match(found[1], /X --> Y/);
	assert.equal(extractMermaids("plain text").length, 0);
});

test("renders a finalized message", () => {
	assert.equal(messageText({ content: [{ type: "text", text: "hi" }] } as never), "hi");
	const rendered = renderMessageMarkdown({
		role: "assistant",
		content: [{ type: "text", text: "answer" }, { type: "toolCall", name: "bash", arguments: { command: "ls" } }],
	} as never);
	assert.match(rendered, /Assistant/);
	assert.match(rendered, /`bash`/);
	assert.match(rendered, /ls/);
});

test("summarizeArgs truncates", () => {
	assert.ok(summarizeArgs({ a: "x".repeat(300) }).endsWith("…"));
});

test("pinned diagrams keep one stable path", () => {
	const first = writeDiagram("flowchart LR; A-->B", "pi-tern test", true);
	const second = writeDiagram("flowchart LR; A-->B", "pi-tern test", true);
	assert.equal(first.path, second.path);
	rmSync(first.path, { force: true });
});
