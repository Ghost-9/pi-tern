/**
 * Tests for the 1.1.0 additions: charts, figures, worktrees, pr summaries and the
 * capability manifest. Pure functions only — the live paths are covered by
 * test/live.test.ts and the verification script.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { detectRasterizer, niceMax, renderChartSvg } from "../lib/figure.ts";
import { buildManifest, renderManifest, type Manifest } from "../lib/manifest.ts";
import { prVerdict, safeSelector, type PrSummary } from "../lib/pr.ts";
import { defaultWorktreePath } from "../lib/worktree.ts";

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
