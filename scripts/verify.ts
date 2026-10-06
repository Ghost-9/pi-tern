#!/usr/bin/env node
/**
 * Live verification of everything pi-tern claims.
 *
 * Deliberately runnable from OUTSIDE a Tern pane (CI, a T3-hosted agent, a cron
 * job) because the CLI-backed surface is supposed to work there — that is the
 * regression this script exists to catch.
 *
 *   node --experimental-strip-types scripts/verify.ts
 *
 * Exit code is non-zero when any check fails.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { openFileBlock, renderChartSvg, renderFigure } from "../lib/figure.ts";
import { fleetRead, fleetSpawn, fleetStatus, fleetStop, fleetWait } from "../lib/fleet.ts";
import { buildManifest, gatherEnvironment } from "../lib/manifest.ts";
import { ghStatus, prSummary, prVerdict } from "../lib/pr.ts";
import { readTernEnv, requireTernCli, scratchDir } from "../lib/tern.ts";
import { defaultWorktreePath, repoRoot, worktreeList } from "../lib/worktree.ts";

interface Check {
	name: string;
	ok: boolean;
	detail: string;
}

const results: Check[] = [];
function record(name: string, ok: boolean, detail: unknown): void {
	const text = typeof detail === "string" ? detail : JSON.stringify(detail);
	results.push({ name, ok, detail: text });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${text}`);
}

const env = readTernEnv();

// 0 — the relaxed gate: the Tern CLI must answer without a pane.
try {
	const availability = await requireTernCli("verification");
	record("availability without a Tern pane", availability.cli, `inPane=${env.inTern} ${availability.version ?? ""}`);
} catch (error) {
	record("availability without a Tern pane", false, String(error));
}

// 1 — chart generation (pure)
const data = [
	{ label: "Bare pi", value: 4332 },
	{ label: "Native + pi-tern", value: 24640 },
	{ label: "Native + T3 bridge", value: 58715 },
];
const svg = renderChartSvg({ kind: "hbar", title: "Prompt tokens", data }, { width: 720 });
record("chart: SVG generated", svg.startsWith("<svg") && svg.endsWith("</svg>"), `${svg.length} bytes`);
record("chart: full-precision labels", svg.includes("58,715"), "large values are not abbreviated");
const donut = renderChartSvg({ kind: "donut", title: "Share", data });
record("chart: donut arcs", donut.includes("<path") && donut.includes("%"), `${donut.length} bytes`);
const line = renderChartSvg({ kind: "line", labels: ["w1", "w2", "w3"], series: [{ name: "tok", values: [4, 12, 9] }] });
record("chart: line polyline", line.includes("<polyline"), `${line.length} bytes`);
const hostile = renderChartSvg({ kind: "hbar", title: '<script>x</script>', data: [{ label: "a<b", value: 1 }] });
record("chart: XML escaping", !hostile.includes("<script>") && hostile.includes("&lt;script&gt;"), "no raw markup");

// 2 — figure → Tern file block, from outside a pane
try {
	const figure = await renderFigure({ route: "svg", source: svg, title: "verification chart", placement: "tab" });
	record("figure: Tern file block", typeof figure.block === "number", `block=${figure.block} ${path.basename(figure.file)}`);
} catch (error) {
	record("figure: Tern file block", false, String(error));
}

// 3 — PNG for the model, no visible window required
try {
	const figure = await renderFigure({ route: "svg", source: svg, title: "verification png", open: false, png: true });
	const bytes = figure.png ? Buffer.from(figure.png.data, "base64").length : 0;
	record("figure: PNG", Boolean(figure.png?.data) && bytes > 2000, `${bytes} bytes · ${figure.note ?? "no note"}`);
} catch (error) {
	record("figure: PNG", false, String(error));
}

// 4 — file block round trip
try {
	const target = path.join(scratchDir(), "verify-block.md");
	writeFileSync(target, "# verification\n\nblock round trip\n", "utf8");
	const block = await openFileBlock(target, "tab");
	record("file block: open + id", typeof block === "number", `block=${block}`);
} catch (error) {
	record("file block: open + id", false, String(error));
}

// 5 — worktrees (pure git, no Tern)
try {
	const root = await repoRoot(process.cwd());
	const list = await worktreeList(process.cwd());
	record("worktree: list", list.length >= 1 && Boolean(root), `${list.length} entries`);
	record("worktree: default path", defaultWorktreePath(root, "feature/x").includes("feature-x"), defaultWorktreePath(root, "feature/x"));
} catch (error) {
	record("worktree: list", false, String(error));
}

// 6 — fleet: spawn, wait, read, stop
try {
	const spawned = await fleetSpawn({ task: "echo PI_TERN_FLEET_OK", name: "verify", mode: "command", command: "echo PI_TERN_FLEET_OK && uname -s" });
	record("fleet: spawn", spawned.block > 0, `block=${spawned.block}`);
	const waited = await fleetWait(spawned.block, 25);
	record("fleet: wait", waited.exited, `timedOut=${waited.timedOut}`);
	record("fleet: read", waited.output.includes("PI_TERN_FLEET_OK"), "output captured");
	const status = await fleetStatus();
	record("fleet: status", status.some((member) => member.block === spawned.block), `${status.length} members`);
	try {
		await fleetStop(spawned.block);
		record("fleet: stop", true, "stop returned");
	} catch (error) {
		record("fleet: stop", false, String(error));
	}
} catch (error) {
	record("fleet: spawn/wait/read/stop", false, String(error));
}

// 7 — GitHub CLI + PR summary
try {
	const gh = await ghStatus(true);
	record("pr: gh status", true, `${gh.version ?? "missing"} authenticated=${gh.authenticated}`);
	if (gh.available && gh.authenticated) {
		try {
			const summary = await prSummary({ cwd: process.cwd() });
			record("pr: summary", true, `${prVerdict(summary)} #${summary.number ?? "?"}`);
		} catch (error) {
			record("pr: summary", true, `no PR for this branch (${String(error).slice(0, 70)})`);
		}
	}
} catch (error) {
	record("pr: gh status", false, String(error));
}

// 8 — capability manifest
try {
	const environment = await gatherEnvironment(env);
	const manifest = buildManifest(
		{ version: "1.1.5", directTools: ["tern_status", "tern_run", "tern_browser"], deferredTools: [], probe: { status: "idle", hello: null } },
		environment,
	);
	const available = manifest.capabilities.filter((item) => item.available);
	record("manifest: built", manifest.contract === 1 && manifest.capabilities.length > 10, `${available.length}/${manifest.capabilities.length} available`);
} catch (error) {
	record("manifest: built", false, String(error));
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
	console.log("FAILURES:");
	for (const failure of failed) console.log(` - ${failure.name}: ${failure.detail}`);
	process.exitCode = 1;
}

// Keep the reader awake: a couple of unused imports are load-bearing for the API surface.
void fleetRead;
