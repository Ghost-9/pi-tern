/**
 * The Luau this extension ships against Tern's declared plugin API.
 *
 * The bridge plugin was written by hand against 0.5.x, and nothing checked it against
 * `tern.d.luau`. Two properties make that dangerous:
 *
 *   1. the vocabulary has already drifted once (0.5.x → 0.9.8 lost `program-palette`, added
 *      `row`/`media`), so "Tern's API is stable" is not an assumption this project can make;
 *   2. a window entry that fails to *compile* is invisible from the CLI — `tern plugin reload`
 *      answered `status: "ready"` and `problems: []` for a window.luau with `this is not lua`
 *      appended (measured on 0.9.8). Only starting a window compiles it.
 *
 * So the check is static and pinned: the declared API of Tern 0.9.8 is extracted into a fixture by
 * `scripts/plugin-api-check.mjs --write`, and every `tern.*` path and `cx.*:method` the shipped Luau
 * uses must be in it. The live variant runs in test/tern-live.test.ts, where a real `tern plugin
 * types` can also be asked.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BRIDGE_WINDOW_LUAU } from "../lib/bridge-plugin.ts";
import { TOOLS_WINDOW_LUAU } from "../lib/tools-plugin.ts";
import { checkAgainst, extractUsedSymbols, type DeclaredApi } from "../lib/luau-api.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(readFileSync(path.join(root, "test", "fixtures", "tern-api-0.9.8.json"), "utf8")) as {
	ternVersion: string;
	source: string;
	api: DeclaredApi;
};

test("the pinned declaration is Tern 0.9.8's, and it is not empty", () => {
	// A fixture that lost most of its entries would make every check below vacuous, which is the
	// silent-skip failure mode this project has already been bitten by once.
	assert.match(fixture.ternVersion, /0\.9\.8/);
	assert.match(fixture.source, /tern plugin types/);
	assert.ok(fixture.api.tern.length >= 90, `the tern module declares ${fixture.api.tern.length} paths`);
	assert.ok(Object.keys(fixture.api.externTypes).length >= 18, "and the cx types are there");
	assert.ok(fixture.api.externTypes.CanvasCx?.includes("open"), "CanvasCx:open is the call the dashboard depends on");
	assert.ok(fixture.api.externTypes.WindowCx?.includes("canvas"), "WindowCx:canvas is the member every panel goes through");
});

test("every symbol the shipped Luau uses is declared by Tern 0.9.8", () => {
	const result = checkAgainst(fixture.api, [BRIDGE_WINDOW_LUAU, TOOLS_WINDOW_LUAU]);
	assert.deepEqual(result.missing, [], `undeclared: ${result.missing.join(", ")}`);
	assert.ok(result.used >= 60, `the extractor found ${result.used} used symbols — fewer means it stopped reading the Luau`);
	assert.ok(result.declaredTern >= 90);
});

test("the extractor really reads both declaration forms, so the check is not vacuous", () => {
	// A nested table member (`tern.ui.bars`) and an extern-type method (`cx.canvas:open`) are the two
	// forms Tern emits. If either stopped being extracted, `missing` would stay empty for the wrong
	// reason, so both are asserted against a small hand-written declaration.
	const samples = extractUsedSymbols(BRIDGE_WINDOW_LUAU);
	assert.ok(samples.tern.includes("tern.ui.bars"), "a nested table member is extracted");
	assert.ok(samples.tern.includes("tern.carly.export"), "a nested export is extracted");
	assert.deepEqual(samples.cx.canvas?.slice(0, 2), ["get", "list"], "cx methods are extracted and sorted");
	assert.ok(!samples.tern.some((symbol) => symbol.endsWith(".")), "no trailing dot from prose");

	// And a renamed member is reported, not ignored.
	const broken = checkAgainst(fixture.api, [`local x = tern.ui.bars_v2({})`]);
	assert.deepEqual(broken.missing, ["tern.ui.bars_v2"]);
	const brokenMethod = checkAgainst(fixture.api, [`cx.canvas:openEverything()`]);
	assert.deepEqual(brokenMethod.missing, ["cx.canvas:openEverything"]);
	const unknownMember = checkAgainst(fixture.api, [`cx.hologram:show()`]);
	assert.deepEqual(unknownMember.missing, ["cx.hologram"]);
});

test("comments that mention the API do not count as calls", () => {
	const source = ["-- executes the requested cx.* operations", "-- tern.ui.bars takes pairs", "local ok = true"].join("\n");
	const used = extractUsedSymbols(source);
	assert.deepEqual(used.tern, []);
	assert.deepEqual(used.cx, {});
});
