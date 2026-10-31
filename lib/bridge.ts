/**
 * pi-bridge: the extension writes a Markdown dashboard; the Tern plugin renders it in a canvas.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BRIDGE_PLUGIN_TOML, BRIDGE_WINDOW_LUAU } from "./bridge-plugin.ts";
import { TOOLS_PLUGIN_TOML, TOOLS_WINDOW_LUAU } from "./tools-plugin.ts";
import { checkApi, type ApiCheck } from "./luau-api.ts";
import { runTern, scratchDir } from "./tern.ts";
import { PLUGIN_VERSION } from "./version.ts";

export interface DashboardData {
	version: string;
	tern?: string;
	model: string;
	context?: string;
	cwd: string;
	mirror: string;
	lastDiagram?: string;
	lastShell?: string;
	browserTabs: number[];
	toc?: string[];
	recent?: string[];
	now?: Date;
	/** Files the conversation refers to, for the panel's clickable path list. */
	files?: Array<{ path: string; cwd?: string; line?: number; exists?: boolean }>;
	/** A native bar chart (tern.ui.bars takes {label, value} pairs). */
	chart?: { title?: string; series: Array<{ label: string; value: number }> };
	/**
	 * Tern's `reduce-motion` setting, copied out of the TSP hello.
	 *
	 * Both panels auto-refresh on a 3 s timer, which is animation whether or not it is called that.
	 * Tern honours this flag everywhere since 0.5.2; pi-tern advertised it in the hello and then
	 * ignored it, which made the dashboard the one surface in the window that did not.
	 */
	reduceMotion?: boolean;
	/**
	 * Tool results from this session, so the panel can render them as native widgets.
	 *
	 * These were previously invisible in Tern: a `git diff` reached the reader as `+`/`-` text in a
	 * code box because the transcript was a `rows` mirror, while Tern has real widgets for all of
	 * it — `tern.ui.diff`, `tern.ui.code` and `tern.ui.test_summary` — sitting unused. The shape
	 * mirrors each widget's own signature so the plugin does no parsing: it passes what it is given.
	 */
	toolResults?: ToolResult[];
}

/** One tool result, already classified by the extension. */
export interface ToolResult {
	/** Stable id, so a re-render replaces the card instead of appending another. */
	id: string;
	tool: string;
	/** `diff` | `code` | `tests` | `text` — decides which native widget renders it. */
	kind: "diff" | "code" | "tests" | "text";
	at: string;
	/** A unified diff for `kind: "diff"`. */
	diff?: string;
	/** The file the diff belongs to; Tern picks the grammar from the extension. */
	path?: string;
	/** Source for `kind: "code"`. */
	code?: string;
	/** Language for `kind: "code"` — the grammar Tern highlights with. */
	lang?: string;
	/** Counts for `kind: "tests"`. */
	tests?: { passed: number; failed: number; skipped: number; took?: string };
	/** Fallback text when the tool produced something none of the widgets model. */
	text?: string;
}

export function bridgeDir(): string {
	return path.join(scratchDir(), "pi-bridge");
}

export function buildDashboard(data: DashboardData): string {
	const time = (data.now ?? new Date()).toISOString().slice(11, 19);
	const toc = (data.toc ?? []).slice(-10);
	const recent = (data.recent ?? []).slice(-6);
	return [
		"# π · pi-tern",
		"",
		`_${data.model} · ctx ${data.context ?? "?"} · ${data.cwd} · ${time}_`,
		"",
		"| Field | Value |",
		"| --- | --- |",
		`| pi-tern | ${data.version} |`,
		`| Tern | ${data.tern ?? "?"} |`,
		`| mirror | ${data.mirror} |`,
		`| last diagram | ${data.lastDiagram ?? "—"} |`,
		`| last shell | ${data.lastShell ?? "—"} |`,
		`| browser tabs | ${data.browserTabs.length > 0 ? data.browserTabs.join(", ") : "—"} |`,
		"",
		"## Session",
		...(toc.length > 0 ? toc.map((entry) => `- ${entry}`) : ["- —"]),
		"",
		"## Recent activity",
		...(recent.length > 0 ? recent.map((entry) => `- ${entry}`) : ["- —"]),
		"",
		"```mermaid",
		"flowchart LR",
		"  PI[pi] --> TERN[Tern]",
		"  PI --> RUN[visible shell panes]",
		"  PI --> DOC[mermaid blocks]",
		"```",
		"",
		"_Press ctrl+shift+f10 in Tern to open or refresh this canvas._",
		"",
	].join("\n");
}

export function writeDashboard(markdown: string): string {
	const dir = bridgeDir();
	mkdirSync(dir, { recursive: true });
	const file = path.join(dir, "dashboard.md");
	writeFileSync(file, markdown, "utf8");
	return file;
}

/**
 * The structured panel data, written next to the markdown.
 *
 * The plugin prefers this: a `tern.ui` view can carry clickable path spans, a real button and
 * a native bar chart, none of which markdown can express. The markdown file stays as the
 * fallback for an older plugin or a failed view build.
 */
export function writeDashboardJson(data: DashboardData): string {
	const dir = bridgeDir();
	mkdirSync(dir, { recursive: true });
	const file = path.join(dir, "dashboard.json");
	// The tool-results panel is a separate plugin, and tern.fs is rooted at a plugin's own
	// directory, so it keeps its own copy. Best effort: a missing panel must not break the writer.
	const toolsDir = path.join(scratchDir(), "pi-tern-tools");
	if (existsSync(toolsDir)) {
		try {
			mkdirSync(toolsDir, { recursive: true });
		} catch {
			/* handled by the write below */
		}
	}
	const payload = {
		title: `π ${data.version}`,
		model: data.model,
		context: data.context,
		dir: data.cwd,
		tern: data.tern,
		mirror: data.mirror,
		lastDiagram: data.lastDiagram,
		lastShell: data.lastShell,
		browserTabs: data.browserTabs,
		files: (data.files ?? []).slice(0, 40),
		chart: data.chart,
		// The tool-results panel plugin reads this; without it the panel always says "none yet".
		toolResults: data.toolResults ?? [],
		reduceMotion: data.reduceMotion === true,
		markdown: buildPanelMarkdown(data),
		updatedAt: (data.now ?? new Date()).toISOString(),
	};
	writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
	try {
		writeFileSync(path.join(toolsDir, "dashboard.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
	} catch {
		/* the panel plugin is optional */
	}
	return file;
}

/** The panel's markdown body: session TOC, recent activity and the wiring diagram. */
function buildPanelMarkdown(data: DashboardData): string {
	const toc = (data.toc ?? []).slice(-10);
	const recent = (data.recent ?? []).slice(-6);
	return [
		"## Session",
		...(toc.length > 0 ? toc.map((entry) => `- ${entry}`) : ["- —"]),
		"",
		"## Recent activity",
		...(recent.length > 0 ? recent.map((entry) => `- ${entry}`) : ["- —"]),
		"",
		"## Wiring",
		"",
		"```mermaid",
		"flowchart LR",
		"  PI[pi] --> TERN[Tern]",
		"  PI --> RUN[visible shell panes]",
		"  PI --> DOC[native md + charts]",
		"```",
	].join("\n");
}

export function installBridgeFiles(): string {
	const dir = bridgeDir();
	mkdirSync(dir, { recursive: true });
	writeFileSync(path.join(dir, "plugin.toml"), BRIDGE_PLUGIN_TOML, "utf8");
	writeFileSync(path.join(dir, "window.luau"), BRIDGE_WINDOW_LUAU, "utf8");
	// Record which shipped build produced these files. `bridgeStatus` compares against it, so a
	// same-version edit to the Luau still propagates instead of being masked by a matching version
	// number — the deployed copy here was 16 lines behind while `upToDate` reported true.
	writeFileSync(path.join(dir, "pi-tern-build.json"), `${bridgeBuildId()}\n`, "utf8");
	return dir;
}

/**
 * An identity for the *content* this extension ships: the plugin version plus a hash of the manifest
 * and the window entry. Version alone is not enough — every fix within one version would otherwise
 * need a version bump, and until then a stale window entry would keep running with the plugin
 * reporting itself current, which is the same shape of bug as the v1.1.3 mailbox guard.
 */
export function bridgeBuildId(): string {
	const hash = createHash("sha256").update(BRIDGE_PLUGIN_TOML).update(BRIDGE_WINDOW_LUAU).digest("hex");
	return `${PLUGIN_VERSION}-${hash.slice(0, 16)}`;
}

/**
 * Install and link the tool-results panel plugin.
 *
 * It lives in the same directory as pi-bridge on purpose: it only *reads* `dashboard.json`, and
 * sharing the directory is what lets it work without a second mailbox protocol. It never writes the
 * request/response files, so the two cannot collide.
 */
export async function installToolsPlugin(): Promise<{ dir: string; linked: boolean }> {
	const dir = bridgeDir();
	writeFileSync(path.join(dir, "pi-tern-tools.toml"), TOOLS_PLUGIN_TOML, "utf8");
	// A plugin directory holds one manifest, so the second plugin needs its own directory alongside.
	const toolsDir = path.join(scratchDir(), "pi-tern-tools");
	mkdirSync(toolsDir, { recursive: true });
	// The panel reads dashboard.json from its own directory, so point it at pi-bridge's by copying
	// the writer's target rather than reaching across: tern.fs is rooted at the plugin directory.
	writeFileSync(path.join(toolsDir, "plugin.toml"), TOOLS_PLUGIN_TOML, "utf8");
	writeFileSync(path.join(toolsDir, "window.luau"), TOOLS_WINDOW_LUAU, "utf8");
	writeFileSync(path.join(toolsDir, "dashboard.json"), readDashboardOrEmpty(), "utf8");
	writeFileSync(path.join(toolsDir, "pi-tern-build.json"), `${bridgeBuildId()}\n`, "utf8");

	const link = await runTern(["plugin", "link", toolsDir], 15000);
	const reload = await runTern(["plugin", "reload"], 30000);
	return { dir: toolsDir, linked: link.code === 0 && reload.code === 0 };
}

function readDashboardOrEmpty(): string {
	try {
		return readFileSync(path.join(bridgeDir(), "dashboard.json"), "utf8");
	} catch {
		return JSON.stringify({ toolResults: [] });
	}
}

/** A plugin as `tern plugin list --json` reports it (0.9.8 shape, every field optional). */
export interface PluginEntry {
	id?: string;
	name?: string;
	version?: string;
	status?: string;
	window?: boolean;
	host?: boolean;
	/** Per-plugin problems are not in 0.9.8's list, but a newer build may add them. */
	problems?: unknown[];
}

/** The answer to `tern plugin list|reload --json`. */
export interface PluginReport {
	plugins: PluginEntry[];
	/** Directory/global problems: a manifest that failed to parse, a copy that will not load. */
	problems: unknown[];
	jit?: boolean;
	canvas?: boolean;
}

function parsePluginReport(stdout: string): PluginReport | null {
	try {
		const parsed = JSON.parse(stdout) as PluginReport;
		// 0.5.x printed a bare array from some verbs; accept both rather than reporting "no plugins".
		if (Array.isArray(parsed)) return { plugins: parsed as PluginEntry[], problems: [] };
		if (!parsed || !Array.isArray(parsed.plugins)) return null;
		return { plugins: parsed.plugins, problems: Array.isArray(parsed.problems) ? parsed.problems : [], ...(parsed.jit !== undefined ? { jit: parsed.jit } : {}), ...(parsed.canvas !== undefined ? { canvas: parsed.canvas } : {}) };
	} catch {
		return null;
	}
}

export interface BridgeLinkResult {
	dir: string;
	linkCode: number;
	reloadCode: number;
	/** The id Tern assigned, when `tern plugin link --json` named it. */
	id?: string;
	/** The version Tern read out of the manifest it just installed. */
	version?: string;
	/** `ready` when the daemon compiled it; absent when the build has no `--json` on these verbs. */
	status?: string;
	problems: unknown[];
	/** Tern's own words when the link or the reload failed. */
	error?: string;
}

export async function linkBridge(): Promise<BridgeLinkResult> {
	const dir = installBridgeFiles();
	const link = await runTern(["plugin", "link", dir, "--json"], 15000);
	// `reload` is what makes the daemon compile it; without one the link only applies at next start.
	const reload = await runTern(["plugin", "reload", "--json"], 30000);
	// Best effort: a failure here costs the tool panel, not the data plane.
	await installToolsPlugin().catch(() => undefined);

	const result: BridgeLinkResult = { dir, linkCode: link.code, reloadCode: reload.code, problems: [] };
	try {
		const linked = JSON.parse(link.stdout) as { id?: string; version?: string };
		if (typeof linked.id === "string") result.id = linked.id;
		if (typeof linked.version === "string") result.version = linked.version;
	} catch {
		/* 0.5.x printed nothing here; the exit code is all there is */
	}
	const report = parsePluginReport(reload.stdout);
	if (report) {
		result.problems = report.problems;
		const bridge = report.plugins.find((plugin) => plugin.id === "pi-bridge");
		if (bridge?.status) result.status = bridge.status;
		if (!bridge) result.error = "the daemon reloaded but does not list pi-bridge";
		else if (result.problems.length > 0) result.error = `Tern reported ${result.problems.length} plugin problem(s)`;
	}
	if (link.code !== 0) result.error = (link.stderr || link.stdout).trim() || `tern plugin link exited ${link.code}`;
	else if (reload.code !== 0) result.error = (reload.stderr || reload.stdout).trim() || `tern plugin reload exited ${reload.code}`;
	return result;
}

/**
 * Ask Tern to write its plugin API declaration into `dir`: `tern plugin types DIR` → `tern.d.luau`.
 *
 * This is the authoritative contract for the Luau this extension ships, so having the extension
 * produce it is what lets an editor (luau-lsp) or `scripts/plugin-api-check.mjs` compare the two
 * without a human hunting for the file. 0.5.x has no such verb, hence the code/error pair.
 */
export async function bridgeTypes(
	dir: string,
	timeoutMs = 20000,
): Promise<{ file: string; code: number; error?: string; api?: ApiCheck }> {
	mkdirSync(dir, { recursive: true });
	const result = await runTern(["plugin", "types", dir, "--json"], timeoutMs);
	// 0.9.8 answers `{"file": …}`; the documented destination is `DIR/tern.d.luau`, so the answer is
	// preferred when it is there and the documented path is the fallback.
	let file = path.join(dir, "tern.d.luau");
	try {
		const answered = JSON.parse(result.stdout) as { file?: unknown };
		if (typeof answered.file === "string" && answered.file.length > 0) file = answered.file;
	} catch {
		/* no JSON: keep the documented path */
	}
	if (result.code !== 0) {
		const error = (result.stderr || result.stdout).trim() || `tern plugin types exited ${result.code}`;
		return { file, code: result.code, error };
	}
	// The declaration is only worth writing if the Luau this build ships still matches it: that is
	// the drift check, and it costs one read because the file was just written.
	let api: ApiCheck | undefined;
	try {
		api = checkApi(readFileSync(file, "utf8"), [BRIDGE_WINDOW_LUAU, TOOLS_WINDOW_LUAU]);
	} catch {
		/* an unreadable declaration is reported as "no check", not as a match */
	}
	return { file, code: result.code, ...(api ? { api } : {}) };
}

/**
 * Whether the installed bridge is the version the extension ships.
 *
 * A window plugin's Luau is only compiled when a window starts, so a plugin can report
 * `ready` with `problems: []` while still running last release's code. Comparing the
 * version is what actually catches a stale install.
 *
 * `status` and `problems` come from the same JSON now: a plugin that Tern reports as failed to
 * load is not "up to date" however well its version matches, and before 1.2 the manifest would
 * have said `bridge: installed, upToDate` about it.
 */
export async function bridgeStatus(): Promise<{
	installed: boolean;
	version?: string;
	upToDate: boolean;
	status?: string;
	problems?: unknown[];
}> {
	try {
		const result = await runTern(["plugin", "list", "--json"], 20000);
		if (result.code !== 0) return { installed: false, upToDate: false };
		const report = parsePluginReport(result.stdout);
		const bridge = report?.plugins.find((plugin) => plugin.id === "pi-bridge");
		if (!report || !bridge) return { installed: false, upToDate: false, ...(report ? { problems: report.problems } : {}) };
		const problems = [...report.problems, ...(Array.isArray(bridge.problems) ? bridge.problems : [])];
		const status = bridge.status;
		const expected = BRIDGE_PLUGIN_TOML.match(/version = "([^"]+)"/)?.[1];
		const base = { installed: true, ...(bridge.version ? { version: bridge.version } : {}), ...(status ? { status } : {}), problems };
		if (bridge.version !== expected) return { ...base, upToDate: false };
		if (status !== undefined && status !== "ready") return { ...base, upToDate: false };
		if (problems.length > 0) return { ...base, upToDate: false };
		// The version matches, but the deployed files can still be older than what this extension
		// ships: a window entry is compiled at window start, so a stale copy keeps running old code
		// while everything reports itself current. Compare the recorded content id.
		const stamp = path.join(bridgeDir(), "pi-tern-build.json");
		let recorded: string | null = null;
		try {
			recorded = readFileSync(stamp, "utf8").trim();
		} catch {
			recorded = null;
		}
		return { ...base, upToDate: recorded === bridgeBuildId() };
	} catch {
		return { installed: false, upToDate: false };
	}
}

/**
 * One-install promise: pi-tern alone is enough. On first session start inside Tern the
 * bridge plugin is linked automatically; later starts only refresh its files.
 */
export async function ensureBridge(): Promise<{
	installed: boolean;
	dir: string;
	upToDate: boolean;
	status?: string;
	problems?: unknown[];
}> {
	try {
		const status = await bridgeStatus();
		if (status.installed) {
			// Only rewrite when the shipped Luau actually differs. A window plugin is compiled at
			// window start, so a stale copy silently keeps running old code — hence the version check
			// rather than a blind reinstall on every session start. A plugin Tern reports as failed
			// (`status: "error"` or a non-empty `problems`) is rewritten for the same reason: leaving
			// a broken copy in place because its version string matched is how a panel stays dead.
			if (!status.upToDate) {
				installBridgeFiles();
				await runTern(["plugin", "reload", "--json"], 30000);
			}
			return {
				installed: false,
				dir: bridgeDir(),
				upToDate: status.upToDate,
				...(status.status ? { status: status.status } : {}),
				...(status.problems ? { problems: status.problems } : {}),
			};
		}
	} catch {
		/* fall through to install */
	}
	const result = await linkBridge();
	return { installed: true, dir: result.dir, upToDate: true };
}
