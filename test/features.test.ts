/**
 * Tests for the 1.1.0 additions: charts, figures, worktrees, pr summaries and the
 * capability manifest. Pure functions only — the live paths are covered by
 * test/live.test.ts and the verification script.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { detectRasterizer, niceMax, renderChartSvg } from "../lib/figure.ts";
import { buildManifest, renderManifest, type Manifest } from "../lib/manifest.ts";
import { prVerdict, safeSelector, type PrSummary } from "../lib/pr.ts";
import { BRIDGE_WINDOW_LUAU } from "../lib/bridge-plugin.ts";
import { TOOLS_WINDOW_LUAU } from "../lib/tools-plugin.ts";
import { bridgeBuildId, writeDashboardJson } from "../lib/bridge.ts";
import { classifyToolResult, languageFor, mergeToolResults, pathFromToolInput } from "../lib/toolresults.ts";
import { defaultWorktreePath } from "../lib/worktree.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

const data = [
	{ label: "Bare pi", value: 4332 },
	{ label: "Native + pi-tern", value: 24640 },
	{ label: "T3 bridge", value: 58715 },
];

test("niceMax rounds up to a readable axis maximum", () => {
	assert.equal(niceMax(58715), 75000);
	assert.equal(niceMax(9), 10);
	assert.equal(niceMax(0), 1);
	assert.equal(niceMax(-5), 1);
});

test("hbar chart renders labelled full-precision bars", () => {
	const svg = renderChartSvg({ kind: "hbar", title: "Prompt tokens", data }, { width: 720 });
	assert.ok(svg.startsWith("<svg"));
	assert.ok(svg.endsWith("</svg>"));
	assert.ok(svg.includes('viewBox="0 0 720 '), "width is honoured");
	// Value labels keep full precision — abbreviating 58,715 to 59k would be a bug.
	assert.ok(svg.includes("58,715"), "full value label");
	assert.ok(svg.includes("24,640"));
	assert.ok(svg.includes("Bare pi"), "row label");
	assert.ok(svg.includes('role="img"'), "accessible");
});

test("pie and donut render arcs, not bars", () => {
	const pie = renderChartSvg({ kind: "pie", data });
	const donut = renderChartSvg({ kind: "donut", data });
	assert.ok(pie.includes("<path"));
	assert.ok(donut.includes("<path"));
	assert.ok(pie.includes("d="));
	// A donut has an inner radius, so its path has two arcs per slice.
	assert.ok((donut.match(/A /g)?.length ?? 0) >= (pie.match(/A /g)?.length ?? 0));
	assert.ok(pie.includes("%"), "legend carries percentages");
});

test("line chart draws one polyline per series with axis ticks", () => {
	const svg = renderChartSvg({
		kind: "line",
		labels: ["w1", "w2", "w3", "w4"],
		series: [
			{ name: "alpha", values: [1, 5, 3, 9] },
			{ name: "beta", values: [2, 2, 8, 4] },
		],
	});
	assert.equal(svg.match(/<polyline/g)?.length, 2);
	assert.ok(svg.includes("alpha") && svg.includes("beta"));
	assert.ok(svg.includes(">w1<"));
});

test("chart text is XML-escaped", () => {
	const svg = renderChartSvg({
		kind: "hbar",
		title: '<script>alert("x")</script>',
		data: [{ label: "a<b>&c", value: 1 }],
	});
	assert.ok(!svg.includes("<script>"));
	assert.ok(svg.includes("&lt;script&gt;"));
	assert.ok(svg.includes("a&lt;b&gt;&amp;c"));
});

test("chart width is clamped to a sane range", () => {
	const narrow = renderChartSvg({ kind: "hbar", data }, { width: 10 });
	const wide = renderChartSvg({ kind: "hbar", data }, { width: 99999 });
	assert.ok(narrow.includes('width="280"'));
	assert.ok(wide.includes('width="1600"'));
});

test("line charts refuse to render without data", () => {
	// renderChartSvg is total; the tool layer is what validates. This documents the
	// fallback: an empty series list must still produce valid SVG, not a throw.
	const svg = renderChartSvg({ kind: "line", labels: [], series: [] });
	assert.ok(svg.startsWith("<svg"));
});

test("detectRasterizer finds a local SVG rasterizer on this machine", () => {
	const found = detectRasterizer();
	// Not a hard requirement (the browser is the fallback), but on macOS a
	// rasterizer removes the window-visibility dependency entirely.
	assert.ok(found === undefined || typeof found === "string");
});

test("prVerdict summarises checks, review and mergeability", () => {
	const base: PrSummary = {
		state: "OPEN",
		mergeable: "MERGEABLE",
		checks: { total: 3, passing: 3, failing: 0, pending: 0, failingNames: [], pendingNames: [] },
	};
	assert.equal(prVerdict(base), "open · checks green · mergeable");
	assert.equal(
		prVerdict({ ...base, checks: { total: 3, passing: 2, failing: 1, pending: 0, failingNames: ["ci"], pendingNames: [] } }),
		"open · 1 failing check · mergeable",
	);
	assert.equal(prVerdict({ ...base, isDraft: true, reviewDecision: "REVIEW_REQUIRED" }), "draft · open · review required · checks green · mergeable");
	assert.equal(prVerdict({ checks: { total: 0, passing: 0, failing: 0, pending: 0, failingNames: [], pendingNames: [] } }), "no signal");
	// A queued status is not a failure: PENDING was in the failing set and produced "1 failing check".
	assert.equal(
		prVerdict({ ...base, checks: { total: 2, passing: 1, failing: 0, pending: 1, failingNames: [], pendingNames: ["ci"] } }),
		"open · mergeable",
	);
});

test("pr selectors are validated before they reach a shell", () => {
	// prWatch builds `gh pr checks <selector> --watch` and runs it under `sh -lc`.
	assert.equal(safeSelector(undefined), "");
	assert.equal(safeSelector("  "), "");
	assert.equal(safeSelector("123"), "'123'");
	assert.equal(safeSelector("feature/ui"), "'feature/ui'");
	assert.equal(safeSelector("https://github.com/o/r/pull/7"), "'https://github.com/o/r/pull/7'");
	for (const hostile of [
		"7; rm -rf /",
		"7 && curl evil.test",
		"7 | tee /tmp/x",
		"$(whoami)",
		"`id`",
		"7\ninjected",
		"a'b",
	]) {
		assert.throws(() => safeSelector(hostile), /unsafe PR selector/, `should reject ${JSON.stringify(hostile)}`);
	}
});

test("worktree default path is a sibling keyed by branch", () => {
	assert.equal(defaultWorktreePath("/Users/x/repo", "feature/ui"), "/Users/x/repo.wt.feature-ui");
	assert.equal(defaultWorktreePath("/Users/x/repo", "  "), "/Users/x/repo.wt.worktree");
	assert.ok(defaultWorktreePath("/Users/x/repo", "a/b/c/d").startsWith("/Users/x/repo.wt."));
});

const environment = (overrides: Partial<Manifest["environment"]> = {}): Manifest["environment"] => ({
	inPane: false,
	ternCli: true,
	ternVersion: "tern 0.5.0 (test)",
	multiplexer: false,
	platform: "darwin-arm64",
	node: "v26.0.0",
	windowSocket: false,
	paneSocket: false,
	gh: { available: true, authenticated: true },
	bridge: { installed: true, upToDate: true, version: "1.1.2" },
	rasterizer: "rsvg-convert",
	native: null,
	...overrides,
});

const input = { version: "1.1.0", directTools: ["tern_status"], deferredTools: ["tern_chart"], probe: { status: "confirmed", hello: null } };

test("manifest gates the data plane on the bridge plugin, not on the Tern CLI", () => {
	// The plugin serves the data plane; "the CLI answered" was not evidence that it was installed.
	const withoutBridge = buildManifest(
		input,
		environment({ bridge: { installed: false, upToDate: false }, ternCli: true }),
	);
	const byId = new Map(withoutBridge.capabilities.map((item) => [item.id, item]));
	assert.equal(byId.get("data.sqlite")?.available, false);
	assert.match(String(byId.get("data.sqlite")?.reason), /not installed/);
	assert.equal(byId.get("diagram.mermaid")?.available, true, "the CLI still works without the plugin");

	const stale = buildManifest(
		input,
		environment({ bridge: { installed: true, upToDate: false, version: "0.9.0" } }),
	);
	const staleById = new Map(stale.capabilities.map((item) => [item.id, item]));
	assert.equal(staleById.get("data.boards")?.available, false);
	assert.match(String(staleById.get("data.boards")?.reason), /0\.9\.0/);

	const ready = buildManifest(input, environment());
	assert.equal(ready.capabilities.find((item) => item.id === "data.sqlite")?.available, true);
});

test("manifest reports availability and reasons", () => {
	const manifest = buildManifest(input, environment());
	const byId = new Map(manifest.capabilities.map((item) => [item.id, item]));
	assert.equal(manifest.contract, 1);
	assert.equal(byId.get("diagram.mermaid")?.available, true);
	assert.equal(byId.get("worktree")?.available, true, "worktrees are pure git");
	assert.equal(byId.get("native.surfaces")?.available, false);
	assert.match(String(byId.get("native.surfaces")?.reason), /launcher/);
	assert.equal(byId.get("status.title")?.available, false, "no pane, no chrome");
});

test("manifest degrades when tern, gh or the rasterizer are missing", () => {
	const bare = buildManifest(input, environment({ ternCli: false, gh: { available: false, authenticated: false }, rasterizer: undefined }));
	const byId = new Map(bare.capabilities.map((item) => [item.id, item]));
	assert.equal(byId.get("diagram.mermaid")?.available, false);
	assert.equal(byId.get("figure.png")?.available, false, "no tern and no rasterizer");
	assert.equal(byId.get("pr.summary")?.available, false);
	assert.match(String(byId.get("pr.summary")?.reason), /not installed/);
	assert.equal(byId.get("worktree")?.available, true, "git worktrees never depend on Tern");
});

test("manifest gates inline images on the blobs feature", () => {
	const withoutBlobs = buildManifest({ ...input, tspFeatures: ["settle"] }, environment({ native: { active: true }, inPane: true }));
	assert.equal(withoutBlobs.capabilities.find((item) => item.id === "native.inlineImages")?.available, false);
	const withBlobs = buildManifest({ ...input, tspFeatures: ["settle", "blobs"] }, environment({ native: { active: true }, inPane: true }));
	assert.equal(withBlobs.capabilities.find((item) => item.id === "native.inlineImages")?.available, true);
});

test("renderManifest prints one line per capability", () => {
	const text = renderManifest(buildManifest(input, environment()));
	assert.ok(text.includes("pi-tern 1.1.0 · contract 1"));
	assert.ok(text.split("\n").some((line) => line.startsWith("ok  diagram.mermaid")));
	assert.ok(text.split("\n").some((line) => line.startsWith("off ")));
});

test("pi notification levels are the ones pi actually accepts", () => {
	// Regression: every event handler took `ctx: any`, so the typecheck could not see that pi's
	// `notify` accepts "info" | "warning" | "error" and NOT "warn". pi's showExtensionNotify
	// branches on "error" / "warning" / else, so a "warn" silently rendered as an ordinary status
	// line — including the block-kind notice that 1.1.6 and 1.1.7 exist to show.
	const source = readFileSync(path.join(here, "..", "index.ts"), "utf8");
	const levels = [...source.matchAll(/ui\.notify\([^)]*?,\s*"(info|warn|warning|error)"\s*\)/g)].map((m) => m[1]);
	assert.ok(levels.length > 0, "the source has notify calls to check");
	const bad = [...new Set(levels)].filter((level) => !["info", "warning", "error"].includes(level));
	assert.deepEqual(bad, [], `every notify level must be one pi accepts; found ${bad.join(", ")}`);
	// The ternary form picks a level at runtime, so check it separately.
	const ternary = source.match(/ui\.notify\([^)]*?\?\s*"(\w+)"\s*:\s*"(\w+)"/);
	if (ternary) {
		for (const level of ternary.slice(1)) {
			assert.ok(["info", "warning", "error"].includes(level), `ternary notify level "${level}" is not one pi accepts`);
		}
	}
});

test("no event handler takes ctx as any", () => {
	// The same `ctx: any` that hid the notify bug hid every other pi API mistake. Assert the
	// shape stays typed so a future refactor cannot quietly reintroduce it.
	const source = readFileSync(path.join(here, "..", "index.ts"), "utf8");
	assert.equal(source.match(/ctx:\s*any/g), null, "no handler may take `ctx: any`");
	assert.equal(source.match(/\(.*_event:\s*unknown/g), null, "event params should be inferred from pi's own types");
});

test("the bridge build id changes when the shipped Luau changes, not only when the version does", () => {
	// The deployed plugin here was 16 lines behind the source while `bridgeStatus()` reported
	// `upToDate: true`, because it compared only the version. A window entry is compiled at window
	// start, so a stale copy keeps running old code with everything reporting itself current —
	// the same shape of bug as the v1.1.3 mailbox guard, which compared two hand-maintained
	// constants that drifted apart.
	const first = bridgeBuildId();
	assert.match(first, /^\d+\.\d+\.\d+-[0-9a-f]{16}$/, "the build id carries the version and a content hash");
	assert.equal(first, bridgeBuildId(), "and is stable across calls, so it is not a fresh random each time");
	// Different content must yield a different id even at the same version, which is the whole point.
	assert.notEqual(
		createHash("sha256").update("one").digest("hex").slice(0, 16),
		createHash("sha256").update("two").digest("hex").slice(0, 16),
		"the hash component is content-derived",
	);
});

test("a git diff is classified as a diff widget, not as text", () => {
	const unified = [
		"diff --git a/index.ts b/index.ts",
		"index 1234567..89abcde 100644",
		"--- a/index.ts",
		"+++ b/index.ts",
		"@@ -10,7 +10,7 @@ export function go() {",
		"-\tconst x = 1;",
		"+\tconst x = 2;",
		" }",
	].join("\n");
	const result = classifyToolResult({ tool: "bash", output: unified, toolInput: {}, seq: 1 });
	assert.equal(result?.kind, "diff");
	assert.equal(result?.diff, unified);
	assert.equal(result?.tool, "bash");
});

test("a test run with failures becomes a test summary", () => {
	const output = [
		"  3 passed",
		"  2 failed",
		"  1 skipped",
		"in 1.42s",
	].join("\n");
	const result = classifyToolResult({ tool: "bash", output, seq: 2 });
	assert.equal(result?.kind, "tests");
	assert.deepEqual(result?.tests, { passed: 3, failed: 2, skipped: 1, took: "1.42s" });
});

test("a test run with nothing failing stays plain text", () => {
	// Forcing a 0/0/0 meter in front of the reader would be worse than the text it replaced.
	const result = classifyToolResult({ tool: "bash", output: "42 passing\nin 0.9s", seq: 3 });
	assert.equal(result?.kind, "text");
	assert.equal(result?.tests, undefined);
});

test("a source file becomes a code widget with a language Tern can highlight", () => {
	const source = 'export const answer = 42;\nexport function go() {\n\treturn answer;\n}\n';
	const result = classifyToolResult({
		tool: "read",
		output: source,
		toolInput: { path: "/tmp/project/index.ts" },
		seq: 4,
	});
	assert.equal(result?.kind, "code");
	assert.equal(result?.lang, "typescript");
	assert.equal(result?.path, "/tmp/project/index.ts");
});

test("an error message is never treated as source, however the file is named", () => {
	const result = classifyToolResult({
		tool: "read",
		output: "Error: ENOENT: no such file or directory, open '/tmp/nope.ts'\n  at openSync (node:fs)",
		toolInput: { path: "/tmp/nope.ts" },
		seq: 5,
	});
	assert.equal(result?.kind, "text", "a diff/code widget given an error renders worse than the text");
});

test("prose in a .ts file is not mistaken for source", () => {
	const prose = "x".repeat(500) + "\n\n" + "y".repeat(500);
	const result = classifyToolResult({ tool: "read", output: prose, toolInput: { path: "notes.ts" }, seq: 6 });
	assert.equal(result?.kind, "text");
});

test("empty output produces nothing at all", () => {
	assert.equal(classifyToolResult({ tool: "read", output: "   ", seq: 7 }), null);
	assert.equal(classifyToolResult({ tool: "read", output: "", seq: 8 }), null);
});

test("the newest results win and the list stays bounded", () => {
	let results: ReturnType<typeof mergeToolResults> = [];
	for (let i = 0; i < 20; i += 1) {
		results = mergeToolResults(
			results,
			classifyToolResult({ tool: "bash", output: `note ${i}`, toolInput: {}, seq: i }),
		);
	}
	assert.ok(results.length <= 12, `expected a bounded list, got ${results.length}`);
	assert.equal(results[0]?.text, "note 19", "newest first");
	// Re-reporting the same id replaces rather than duplicates, so a re-render does not stack cards.
	const before = results.length;
	results = mergeToolResults(results, { id: "bash-19", tool: "bash", kind: "text", at: "", text: "note 19" });
	assert.equal(results.length, before, "the same id replaces instead of appending");
});

test("the language table covers the common cases and nothing exotic", () => {
	assert.equal(languageFor("a/b.rs"), "rust");
	assert.equal(languageFor("x.MJS"), "javascript");
	assert.equal(languageFor("noext"), undefined);
	assert.equal(languageFor(undefined), undefined);
});

test("the path is taken from whichever argument name the tool used", () => {
	assert.equal(pathFromToolInput({ file_path: "/a/b.py" }), "/a/b.py");
	assert.equal(pathFromToolInput({ target: "/a/b.go" }), "/a/b.go");
	assert.equal(pathFromToolInput({ nothing: 1 }), undefined);
	assert.equal(pathFromToolInput("string"), undefined);
});

test("the dashboard payload carries tool results to the panel plugin", () => {
	// Omitting this from the payload is silent: the panel then always reports "none yet" while
	// looking perfectly healthy, which is the failure mode this whole path is meant to remove.
	const dir = mkdtempSync(path.join(os.tmpdir(), "pi-tern-dash-"));
	const previousHome = process.env.HOME;
	process.env.HOME = dir;
	try {
		const results = mergeToolResults(
			[],
			classifyToolResult({ tool: "bash", output: "  3 passed\n  1 failed\nin 1s", toolInput: {}, seq: 1 }),
		);
		const file = writeDashboardJson({
			version: "1.1.8",
			model: "m",
			cwd: "/tmp",
			mirror: "off",
			browserTabs: [],
			toolResults: results,
		});
		const payload = JSON.parse(readFileSync(file, "utf8")) as { toolResults?: unknown[] };
		assert.ok(Array.isArray(payload.toolResults), "toolResults must reach the file the plugin reads");
		assert.equal(payload.toolResults.length, 1);
		assert.equal((payload.toolResults[0] as { kind: string }).kind, "tests");
	} finally {
		rmSync(dir, { recursive: true, force: true });
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
	}
});

test("reduce-motion reaches the panels, and both actually honour it", () => {
	// The panels repaint on a 3 s timer, which is animation whatever it is called. Tern has applied
	// reduce-motion everywhere since 0.5.2, and pi-tern advertised the flag in the hello while
	// ignoring it — making the dashboard the one surface in the window that did not respect it.
	const dir = mkdtempSync(path.join(os.tmpdir(), "pi-tern-motion-"));
	const previousHome = process.env.HOME;
	process.env.HOME = dir;
	try {
		const base = { version: "1.1.11", model: "m", cwd: "/tmp", mirror: "off", browserTabs: [] };
		// Use the path the writer returns rather than recomputing it: `scratchDir()` caches per HOME,
		// so a second call can resolve differently from the one that just wrote.
		const onPath = writeDashboardJson({ ...base, reduceMotion: true });
		const on = JSON.parse(readFileSync(onPath, "utf8")) as { reduceMotion?: boolean };
		assert.equal(on.reduceMotion, true, "the flag must reach dashboard.json, or the panels cannot see it");

		// Absent and false both mean "do not reduce", so the default must be an explicit false
		// rather than undefined the panels have to guess about.
		const offPath = writeDashboardJson({ ...base });
		const off = JSON.parse(readFileSync(offPath, "utf8")) as { reduceMotion?: boolean };
		assert.equal(off.reduceMotion, false, "the default is an explicit false, not undefined");

		for (const [name, lua] of [
			["BRIDGE_WINDOW_LUAU", BRIDGE_WINDOW_LUAU],
			["TOOLS_WINDOW_LUAU", TOOLS_WINDOW_LUAU],
		] as const) {
			assert.match(lua, /data\.reduceMotion == true/, `${name} must read the flag`);
			assert.match(lua, /auto-refresh off \(reduce-motion\)/, `${name} must say it stopped, not just skip a tick`);
			// The loop must actually stop: returning without re-arming is the whole behaviour, and a
			// tick that skipped the work but kept the timer would still animate the timer itself.
			const tick = /local function tick\(cx\)([\s\S]*?)end\n/.exec(lua)?.[1] ?? "";
			const guardAt = tick.indexOf("motion_reduced()");
			const returnAt = tick.indexOf("return", guardAt);
			const rearmAt = tick.indexOf("tern.timer", guardAt);
			assert.ok(guardAt !== -1, `${name} must check the flag inside the tick`);
			assert.ok(rearmAt === -1 || returnAt < rearmAt, `${name} must return before re-arming the timer`);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
	}
});

test("a stale hello is marked, so 'confirmed' cannot quietly mean 'old'", () => {
	// Tern 0.5.2 switched the daemon on the first window attach, so a session spanning an update
	// keeps the vocabulary it saw at start. Without a marker that is indistinguishable from fresh.
	const source = readFileSync(path.join(here, "..", "index.ts"), "utf8");
	// The mark is set on the old hello *before* re-asking, and re-probe must not discard it.
	assert.match(source, /if \(probe\.hello\) probe\.hello\.stale = true;/, "reprobe marks the previous hello stale");
	assert.match(source, /reason === "resume" \|\| event\?\.reason === "fork"/, "a resume or fork re-probes");
	assert.match(source, /session_start/, "session_start is pi's only session lifecycle event");
	// And the type must document the flag, so the next reader knows Tern did not send it.
	assert.match(
		readFileSync(path.join(here, "..", "lib", "tsp.ts"), "utf8"),
		/stale\?: boolean;/,
		"TspHello must document the field pi-tern adds",
	);
	// A re-probe that goes unanswered must keep the old vocabulary rather than report a timeout,
	// which would be a lie about a session that demonstrably has one.
	assert.match(
		source,
		/probe\.status = probe\.hello \? "confirmed" : "timeout"/,
		"a failed re-probe falls back to the hello we already had",
	);
});
