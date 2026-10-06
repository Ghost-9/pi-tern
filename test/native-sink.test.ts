/**
 * Frame-ops test for the native sink.
 *
 * This drives the real sink with a fake stdout and asserts the exact wire shapes, so the
 * encodings verified against Tern (`docs/TSP-ENCODINGS.md`) cannot silently regress — in
 * particular the `blob` op, which Tern rejects with `unknown op blob` and 1.1.0 shipped.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createNativeSink } from "../native/backend.mjs";

const HELLO = {
	cols: 80,
	rows: 24,
	kinds: ["col", "row", "rows", "md", "image", "chart", "editor", "input", "status"],
	features: ["blobs", "aside", "settle", "scroll", "dock"],
};

/** Capture every frame the sink writes and parse the JSON body of each. */
function capture() {
	const frames = [];
	const original = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((chunk) => {
		const text = String(chunk);
		const prefix = "\x1b_tsp;";
		let index = text.indexOf(prefix);
		while (index !== -1) {
			const end = text.indexOf("\x1b\\", index);
			if (end === -1) break;
			const inner = text.slice(index + prefix.length, end);
			const semi = inner.indexOf(";");
			const verb = semi === -1 ? inner : inner.slice(0, semi);
			const brace = inner.indexOf("{", semi + 1);
			if (brace !== -1) {
				try {
					frames.push({ verb, body: JSON.parse(inner.slice(brace)) });
				} catch {
					/* ignore */
				}
			}
			index = text.indexOf(prefix, end + 2);
		}
		return true;
	}) as typeof process.stdout.write;
	return {
		frames,
		restore: () => {
			process.stdout.write = original;
		},
	};
}

function ops(frames) {
	return frames.flatMap((frame) => (frame.verb === "f" ? (frame.body.ops ?? []) : []));
}

test("the sink opens one inline surface and adds region roots under the surface id", () => {
	const cap = capture();
	try {
		const sink = createNativeSink({ hello: HELLO, surfaceId: "test1" });
		sink.markdown({ text: "# hello" });
		const open = cap.frames.find((frame) => frame.verb === "o");
		assert.ok(open, "an open frame was sent");
		assert.equal(open.body.id, "test1");
		assert.equal(open.body.mode, "inline");
		assert.equal(open.body.listen, false);
		const adds = ops(cap.frames).filter((op) => op[0] === "add");
		assert.ok(
			adds.some((op) => op[1] === "main" && op[2] === "test1"),
			"the main region is added under the surface id (the M1 addressing bug)",
		);
	} finally {
		cap.restore();
	}
});

test("markdown emits an md node, never a blob op", () => {
	const cap = capture();
	try {
		const sink = createNativeSink({ hello: HELLO, surfaceId: "test1" });
		const result = sink.markdown({ text: "**bold**", id: "x1" });
		assert.equal(result.ok, true);
		const all = ops(cap.frames);
		assert.equal(all.filter((op) => op[0] === "blob").length, 0, "blob is not a frame op");
		const add = all.find((op) => op[0] === "add" && op[4]?.k === "md");
		assert.ok(add, "an md node was added");
		assert.equal(add[4].p.text, "**bold**");
	} finally {
		cap.restore();
	}
});

test("figure is opt-in and, when enabled, carries inline image bytes", () => {
	const cap = capture();
	const previous = process.env.PI_TERN_INLINE_IMAGES;
	try {
		delete process.env.PI_TERN_INLINE_IMAGES;
		const sink = createNativeSink({ hello: HELLO, surfaceId: "test1" });
		const refused = sink.figure({ data: "AAAA" });
		assert.equal(refused.ok, false);
		process.env.PI_TERN_INLINE_IMAGES = "1";
		const allowed = sink.figure({ data: "AAAA", mime: "image/png" });
		assert.equal(allowed.ok, true);
		const all = ops(cap.frames);
		assert.equal(all.filter((op) => op[0] === "blob").length, 0, "still no blob op");
		const image = all.find((op) => op[4]?.k === "image");
		assert.ok(image, "an image node was added");
		assert.equal(image[4].p.data, "AAAA");
		assert.equal(image[4].p.mime, "image/png");
	} finally {
		if (previous === undefined) delete process.env.PI_TERN_INLINE_IMAGES;
		else process.env.PI_TERN_INLINE_IMAGES = previous;
		cap.restore();
	}
});

test("chart refuses when the kind is not advertised and sends bars when it is", () => {
	const cap = capture();
	try {
		const withoutChart = createNativeSink({ hello: { ...HELLO, kinds: ["md"] }, surfaceId: "test1" });
		assert.equal(withoutChart.chart({ series: [{ label: "a", value: 1 }] }).ok, false);
		const sink = createNativeSink({ hello: HELLO, surfaceId: "test1" });
		const sent = sink.chart({ series: [{ label: "a", value: 1 }], title: "T" });
		assert.equal(sent.ok, true);
		const node = ops(cap.frames).find((op) => op[4]?.k === "chart");
		assert.ok(node, "a chart node was added");
		assert.equal(node[4].p.kind, "bars");
		assert.deepEqual(node[4].p.bars, [{ label: "a", value: 1 }]);
		assert.equal(node[4].p.title, "T");
	} finally {
		cap.restore();
	}
});

test("the aside region is a root under the surface, carrying an md node", () => {
	const cap = capture();
	try {
		const sink = createNativeSink({ hello: HELLO, surfaceId: "test1" });
		const result = sink.aside({ markdown: "body", title: "T", link: "file:///tmp/a.md" });
		assert.equal(result.ok, true);
		const root = ops(cap.frames).find((op) => op[0] === "add" && op[1] === "aside");
		assert.ok(root, "the aside root was added");
		assert.equal(root[2], "test1", "under the surface id");
		assert.equal(root[4].k, "col");
		const node = root[4].c[0];
		assert.equal(node.k, "md");
		assert.ok(node.p.text.includes("[Open in split](file:///tmp/a.md)"), "the button is a link");
	} finally {
		cap.restore();
	}
});

test("aside refuses when the feature is not advertised", () => {
	const cap = capture();
	try {
		const sink = createNativeSink({ hello: { ...HELLO, features: ["blobs"] }, surfaceId: "test1" });
		assert.equal(sink.aside({ markdown: "x" }).ok, false);
	} finally {
		cap.restore();
	}
});

test("transcript markdown is bounded, and switching modes removes the rows node", () => {
	const cap = capture();
	const previous = process.env.PI_TERN_MD_TRANSCRIPT_KEEP;
	try {
		process.env.PI_TERN_MD_TRANSCRIPT_KEEP = "2";
		const sink = createNativeSink({ hello: HELLO, surfaceId: "test1" });
		sink.appendMarkdown({ text: "one", id: "t1", transcript: true });
		sink.appendMarkdown({ text: "two", id: "t2", transcript: true });
		const third = sink.appendMarkdown({ text: "three", id: "t3", transcript: true });
		assert.equal(third.kept, 2, "only two transcript blocks are kept");
		const dels = ops(cap.frames).filter((op) => op[0] === "del");
		assert.deepEqual(dels.map((op) => op[1]), ["t1"], "the oldest is deleted");
		sink.transcript("md");
		sink.flush();
		const delRows = ops(cap.frames).filter((op) => op[0] === "del" && op[1] === "m");
		assert.ok(delRows.length >= 1, "the rows node is removed in md mode");
	} finally {
		if (previous === undefined) delete process.env.PI_TERN_MD_TRANSCRIPT_KEEP;
		else process.env.PI_TERN_MD_TRANSCRIPT_KEEP = previous;
		cap.restore();
	}
});

test("suspend and resume are single frame ops", () => {
	const cap = capture();
	try {
		const sink = createNativeSink({ hello: HELLO, surfaceId: "test1" });
		sink.markdown({ text: "x" });
		assert.equal(sink.suspend(), true);
		assert.equal(sink.suspend(), false, "suspending twice is a no-op");
		assert.equal(sink.resume(), true);
		const all = ops(cap.frames);
		assert.ok(all.some((op) => op[0] === "suspend"));
		assert.ok(all.some((op) => op[0] === "resume"));
	} finally {
		cap.restore();
	}
});
