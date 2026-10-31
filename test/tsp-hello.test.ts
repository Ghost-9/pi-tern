/**
 * The TSP hello, as a compatibility boundary rather than a fixed shape.
 *
 * `asHello` used to be `hello.v === 1 && Array.isArray(hello.kinds)`. Both halves are wrong in a
 * way that fails silently: a build that answers `v: 2`, or one that stops sending `kinds`, makes
 * detection report `absent` — which is exactly what a terminal that does not speak TSP reports —
 * and the whole surface layer stands down with no explanation.
 *
 * The two bodies below are real captures, not inventions:
 *   - Tern 0.4.5/0.5.x: 44 kinds, 10 features (`program-palette` included)
 *   - Tern 0.9.8 (f21d9a3): 46 kinds (`row`, `media` added), 9 features (`program-palette` gone),
 *     plus `hour12` — the vocabulary drifted twice while `v` stayed 1.
 * The hypothetical `v: 2` body is the one that never existed: it proves the *policy*, and the test
 * names say so.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	asHello,
	describeHello,
	encodeHello,
	extractTspMessages,
	negotiateHello,
	parseHello,
	parseHelloMessage,
	supportsFeature,
	supportsKind,
	TERN_KINDS_KNOWN,
	TERN_FEATURES_KNOWN,
	TSP_KNOWN_MAX,
	TSP_VERSION,
} from "../lib/tsp.ts";

/** Tern 0.4.5's reply, as captured in a live pane (the shape 0.5.x still answered). */
const HELLO_045 = {
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
};

/** Tern 0.9.8's reply, captured byte for byte from `tern serve` + a probe program in a pane. */
const HELLO_098 = {
	r: "hello",
	v: 1,
	term: "tern",
	ver: "0.9.8",
	kinds: [
		"col", "row", "card", "section", "rule", "spacer", "text", "md", "code", "diff", "ansi",
		"math", "image", "media", "kv", "table", "tree", "json", "badge", "kbd", "icon", "spinner",
		"shimmer", "elapsed", "progress", "rate", "list", "item", "tabs", "editor", "input",
		"status", "seg", "overlay", "toast", "rows", "picker", "prefs", "tool", "checklist",
		"agent", "chart", "meter", "block", "effort", "el",
	],
	features: ["blobs", "settle", "adopt", "dock", "reduce-motion", "aside", "scroll", "styles", "flow"],
	apc: 65536,
	credits: 2,
	cols: 160,
	cell: { w: 16, h: 33 },
	dark: false,
	reduceMotion: false,
	hour12: false,
};

const frame = (body: unknown): string => `\x1b_tsp;r;${JSON.stringify(body)}\x1b\\`;
const message = (body: unknown) => extractTspMessages(frame(body)).messages[0];

test("the 0.4.5 hello still parses exactly as it did", () => {
	const hello = asHello(message(HELLO_045));
	assert.ok(hello);
	assert.equal(hello.v, 1);
	assert.equal(hello.protocol, 1);
	assert.equal(hello.ver, "0.4.5");
	assert.equal(hello.kinds.length, 44);
	assert.equal(hello.features.length, 10);
	assert.equal(hello.future, undefined, "an old hello is not flagged as a future one");
	assert.ok(hello.features.includes("program-palette"), "a feature this build does not gate on is kept");
});

test("the 0.9.8 hello parses, and its vocabulary differs without breaking anything", () => {
	const hello = asHello(message(HELLO_098));
	assert.ok(hello);
	assert.equal(hello.v, 1, "0.9.8 still answers TSP v1 — the hard equality would have survived this one");
	assert.equal(hello.ver, "0.9.8");
	assert.equal(hello.kinds.length, 46);
	assert.equal(hello.features.length, 9);
	assert.ok(hello.kinds.includes("media"), "a kind this build never draws is still reported");
	assert.ok(!hello.features.includes("program-palette"), "0.9.8 dropped it; nothing may assume it");
	assert.deepEqual(hello.extra, { hour12: false }, "unknown fields are kept, not dropped");

	const negotiation = negotiateHello(hello);
	assert.equal(negotiation.future, false);
	assert.deepEqual(negotiation.kinds.unknown, [], "every 0.9.8 kind is in this build's vocabulary");
	assert.equal(negotiation.kinds.known, 46);
	assert.deepEqual(negotiation.features.unknown, []);
	assert.deepEqual(negotiation.supported, { image: true, chart: true, aside: true, blobs: true });
});

test("a newer TSP version is used, not refused — and is flagged", () => {
	// The hypothetical body: this never shipped. It exists to pin the *policy*: a future version
	// must not silently degrade the integration, because refusing it loses every surface to avoid
	// a risk that a strictly additive v2 does not have.
	const after = { ...HELLO_098, v: 2, kinds: [...HELLO_098.kinds, "hologram"], features: [...HELLO_098.features, "telepathy"] };
	const hello = asHello(message(after));
	assert.ok(hello, "v: 2 is accepted");
	assert.equal(hello.v, 2);
	assert.equal(hello.protocol, TSP_KNOWN_MAX, "it is used as the v1 subset");
	assert.equal(hello.future, true);

	const negotiation = negotiateHello(hello);
	assert.equal(negotiation.future, true);
	assert.deepEqual(negotiation.kinds.unknown, ["hologram"], "the unknown kind is named, not ignored");
	assert.deepEqual(negotiation.features.unknown, ["telepathy"]);
	assert.match(describeHello(hello), /newer than this build's v1/);
	assert.match(describeHello(hello), /hologram/);
});

test("a version written as an array or a string is still a version", () => {
	// We *send* `v: [1]`; a peer that echoes that form is not wrong, it is just different.
	assert.equal(parseHello({ r: "hello", v: [1], kinds: ["md"] }).hello?.v, 1);
	assert.equal(parseHello({ r: "hello", v: [1, 2], kinds: ["md"] }).hello?.v, 2, "the highest offered version");
	assert.equal(parseHello({ r: "hello", v: "1", kinds: ["md"] }).hello?.v, 1);
});

test("a vocabulary written as a comma string is normalized", () => {
	const hello = parseHello({ r: "hello", v: 1, kinds: "md, image ,chart", features: "aside blobs" }).hello;
	assert.ok(hello);
	assert.deepEqual(hello.kinds, ["md", "image", "chart"]);
	assert.deepEqual(hello.features, ["aside", "blobs"]);
});

test("a hello with no kinds at all does not lose every node kind", () => {
	// A newer Tern that moves its vocabulary behind a call must not turn every `supportsKind` into
	// false: empty means "not advertised", which is not evidence of absence.
	const parsed = parseHello({ r: "hello", v: 1, term: "tern", features: ["blobs"] });
	assert.ok(parsed.hello);
	assert.deepEqual(parsed.hello.kinds, []);
	assert.equal(supportsKind(parsed.hello, "md"), true, "cannot prove it is missing, so assume it works");
	assert.equal(supportsFeature(parsed.hello, "blobs"), true);
	assert.equal(supportsFeature(parsed.hello, "aside"), false);
});

test("an explicit vocabulary that omits a kind reports it as unsupported", () => {
	const hello = parseHello({ r: "hello", v: 1, kinds: ["md", "text"], features: ["aside"] }).hello;
	assert.ok(hello);
	assert.equal(supportsKind(hello, "chart"), false);
	assert.equal(supportsFeature(hello, "blobs"), false);
	assert.equal(supportsKind(null, "md"), false, "no hello means no evidence");
	assert.equal(supportsFeature(undefined, "aside"), false);
});

test("garbage is rejected with a reason instead of being mistaken for a terminal", () => {
	const cases: Array<[string, unknown]> = [
		["not an object", "hello"],
		["an array", [1, 2]],
		["null", null],
		["a different reply", { r: "state", v: 1, kinds: ["md"] }],
		["no version", { r: "hello", term: "tern", kinds: ["md"] }],
		["version 0", { r: "hello", v: 0, kinds: ["md"] }],
		["only a greeting", { r: "hello", v: 1 }],
	];
	for (const [label, body] of cases) {
		const parsed = parseHello(body);
		assert.equal(parsed.hello, null, label);
		assert.match(String(parsed.problem), /^(not-a-hello|no-version|empty-hello):/, label);
	}
});

test("a non-reply verb is reported as such, not as a missing hello", () => {
	const parsed = parseHelloMessage({ verb: "e", params: {}, body: { ev: "error" }, raw: "" });
	assert.equal(parsed.hello, null);
	assert.match(String(parsed.problem), /^not-a-reply:/);
});

test("the reply still round-trips through the wire format with the extra fields intact", () => {
	// The whole point of parsing from a frame: the fields `kinds`/`features` are not special-cased
	// by the tokenizer, so a build that adds a field is parsed by the same code path.
	const hello = asHello(message(HELLO_098));
	assert.ok(hello);
	assert.equal(hello.cols, 160);
	assert.deepEqual(hello.cell, { w: 16, h: 33 });
	assert.equal(hello.dark, false);
	assert.equal(hello.reduceMotion, false);
	assert.equal(hello.apc, 65536);
	assert.equal(hello.credits, 2);
});

test("the shipped hello advertises only the version this build implements", () => {
	const out = extractTspMessages(encodeHello("pi-test", "1.2.0")).messages[0];
	assert.deepEqual((out.body as { v: number[] }).v, [TSP_VERSION]);
	assert.equal(TSP_VERSION, 1, "bump TSP_VERSION only with a wire change, not with a Tern release");
});

test("the kind and feature lists this build knows cover both measured vocabularies", () => {
	const kinds = new Set<string>(TERN_KINDS_KNOWN);
	const features = new Set<string>(TERN_FEATURES_KNOWN);
	for (const hello of [HELLO_045, HELLO_098]) {
		for (const kind of hello.kinds) assert.ok(kinds.has(kind), `kind ${kind} is in the known list`);
		for (const feature of hello.features) assert.ok(features.has(feature), `feature ${feature} is in the known list`);
	}
});
