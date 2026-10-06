/**
 * Tests for file-reference detection and linkification — the machinery behind
 * clickable file links and the inline preview panel.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { classify, describeRefs, fileUrl, linkifyFileRefs, parseFileRefs } from "../lib/refs.ts";

const dir = mkdtempSync(path.join(os.tmpdir(), "pi-tern-refs-"));
writeFileSync(path.join(dir, "notes.md"), "# Notes\n");
writeFileSync(path.join(dir, "chart.png"), "not really a png");
writeFileSync(path.join(dir, "src.ts"), "export {};\n");
writeFileSync(path.join(dir, "data.json"), "{}\n");

test("classify maps extensions to kinds", () => {
	assert.equal(classify("md"), "markdown");
	assert.equal(classify("png"), "image");
	assert.equal(classify("pdf"), "pdf");
	assert.equal(classify("json"), "data");
	assert.equal(classify("ts"), "code");
	assert.equal(classify("nope"), "other");
});

test("fileUrl percent-encodes segments", () => {
	assert.equal(fileUrl("/tmp/a b/c.md"), "file:///tmp/a%20b/c.md");
	assert.equal(fileUrl("/tmp/plain.md"), "file:///tmp/plain.md");
});

test("finds backticked, markdown-linked and bare references", () => {
	const text = [
		"I updated `notes.md` and [the chart](chart.png).",
		"Also see src.ts:42 for the call.",
		"And /etc/hosts for the mapping.",
	].join("\n");
	const refs = parseFileRefs(text, { cwd: dir });
	const byName = new Map(refs.map((ref) => [path.basename(ref.abs ?? ref.raw), ref]));
	assert.ok(byName.has("notes.md"));
	assert.equal(byName.get("notes.md")?.kind, "markdown");
	assert.ok(byName.has("chart.png"), "markdown link target found");
	assert.ok(byName.has("src.ts"), "bare relative path found");
	assert.equal(byName.get("src.ts")?.line, 42, "line number parsed");
});

test("resolves existence and sorts existing first", () => {
	const refs = parseFileRefs("`notes.md` and `missing.md`", { cwd: dir });
	assert.equal(refs.length, 2);
	assert.equal(refs[0].exists, true);
	assert.equal(refs[0].abs, path.join(dir, "notes.md"));
	const missing = refs.find((ref) => ref.raw.includes("missing"));
	assert.equal(missing?.exists, false);
});

test("file:// references round-trip", () => {
	const url = fileUrl(path.join(dir, "notes.md"));
	const refs = parseFileRefs(`see ${url}`, { cwd: dir });
	assert.equal(refs[0]?.abs, path.join(dir, "notes.md"));
	assert.equal(refs[0]?.source, "file-url");
});

test("ignores urls and prose that merely contains dots", () => {
	const refs = parseFileRefs("Visit https://example.com/docs.md and e.g. this sentence. Node.js is fine.", { cwd: dir });
	assert.equal(refs.filter((ref) => (ref.abs ?? "").includes("example.com")).length, 0);
	assert.equal(refs.length, 0, JSON.stringify(refs.map((ref) => ref.raw)));
});

test("a bare single-segment name is trusted only when the file exists", () => {
	const refs = parseFileRefs("I edited notes.md and also node.js mentioned in prose.", { cwd: dir });
	assert.deepEqual(refs.map((ref) => ref.raw), ["notes.md"]);
});

test("includeMissing=false keeps only real files", () => {
	const refs = parseFileRefs("`notes.md` `ghost.md`", { cwd: dir, includeMissing: false });
	assert.deepEqual(refs.map((ref) => path.basename(ref.abs ?? "")), ["notes.md"]);
});

test("kindsOnly filters", () => {
	const refs = parseFileRefs("`notes.md` `chart.png` `data.json`", { cwd: dir, kindsOnly: ["image"] });
	assert.deepEqual(refs.map((ref) => path.basename(ref.abs ?? "")), ["chart.png"]);
});

test("limit caps the list", () => {
	const refs = parseFileRefs("`notes.md` `chart.png` `src.ts` `data.json`", { cwd: dir, limit: 2 });
	assert.equal(refs.length, 2);
});

test("linkify turns references into file:// links Tern can open", () => {
	const text = "I wrote notes.md and also `src.ts`.";
	const refs = parseFileRefs(text, { cwd: dir });
	const linked = linkifyFileRefs(text, refs);
	assert.ok(linked.includes(`[notes.md](${fileUrl(path.join(dir, "notes.md"))})`), linked);
	assert.ok(linked.includes(`[\`src.ts\`](${fileUrl(path.join(dir, "src.ts"))})`), linked);
});

test("linkify does not double-link existing markdown links", () => {
	const text = "See [notes](notes.md).";
	const linked = linkifyFileRefs(text, parseFileRefs(text, { cwd: dir }));
	assert.equal(linked, text);
});

test("linkify leaves missing files as plain text", () => {
	const text = "ghost.md is not real";
	const linked = linkifyFileRefs(text, parseFileRefs(text, { cwd: dir }));
	assert.ok(!linked.includes("file://"), linked);
});

test("linkify does not mangle a path inside a longer token", () => {
	const text = "prefixnotes.md should not match";
	const linked = linkifyFileRefs(text, [
		{ raw: "notes.md", abs: path.join(dir, "notes.md"), exists: true, isDirectory: false, kind: "markdown", url: fileUrl(path.join(dir, "notes.md")), source: "backtick" },
	]);
	assert.ok(linked.startsWith("prefixnotes.md"), linked);
});

test("describeRefs marks missing files", () => {
	const refs = parseFileRefs("`notes.md` `ghost.md`", { cwd: dir });
	const text = describeRefs(refs);
	assert.ok(text.includes("notes.md"));
	assert.ok(text.includes("(missing)"));
	assert.equal(describeRefs([]), "no file references found");
});

test("empty input is handled", () => {
	assert.deepEqual(parseFileRefs("", { cwd: dir }), []);
	assert.deepEqual(parseFileRefs("no files here", { cwd: dir }), []);
});
