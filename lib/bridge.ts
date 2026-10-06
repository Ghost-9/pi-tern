/**
 * pi-bridge: the extension writes a Markdown dashboard; the Tern plugin renders it in a canvas.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BRIDGE_PLUGIN_TOML, BRIDGE_WINDOW_LUAU } from "./bridge-plugin.ts";
import { TOOLS_PLUGIN_TOML, TOOLS_WINDOW_LUAU } from "./tools-plugin.ts";
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

export async function linkBridge(): Promise<{ dir: string; linkCode: number; reloadCode: number }> {
	const dir = installBridgeFiles();
	const link = await runTern(["plugin", "link", dir], 15000);
	const reload = await runTern(["plugin", "reload"], 30000);
	// Best effort: a failure here costs the tool panel, not the data plane.
	await installToolsPlugin().catch(() => undefined);
	return { dir, linkCode: link.code, reloadCode: reload.code };
}

async function pluginList(): Promise<Array<{ id?: string; status?: string; problems?: unknown[]; version?: string }>> {
	const result = await runTern(["plugin", "list", "--json"], 20000);
	if (result.code !== 0) throw new Error(result.stderr.trim() || `tern plugin list exited ${result.code}`);
	try {
		const parsed = JSON.parse(result.stdout) as {
			plugins?: Array<{ id?: string; status?: string; problems?: unknown[]; version?: string }>;
		};
		return parsed.plugins ?? [];
	} catch {
		return [];
	}
}

/**
 * Whether the installed bridge is the version the extension ships.
 *
 * A window plugin's Luau is only compiled when a window starts, so a plugin can report
 * `ready` with `problems: []` while still running last release's code. Comparing the
 * version is what actually catches a stale install.
 */
export async function bridgeStatus(): Promise<{ installed: boolean; version?: string; upToDate: boolean }> {
	try {
		const plugins = await pluginList();
		const bridge = plugins.find((plugin) => plugin.id === "pi-bridge");
		if (!bridge) return { installed: false, upToDate: false };
		const expected = BRIDGE_PLUGIN_TOML.match(/version = "([^"]+)"/)?.[1];
		if (bridge.version !== expected) return { installed: true, version: bridge.version, upToDate: false };
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
		return { installed: true, version: bridge.version, upToDate: recorded === bridgeBuildId() };
	} catch {
		return { installed: false, upToDate: false };
	}
}

/**
 * One-install promise: pi-tern alone is enough. On first session start inside Tern the
 * bridge plugin is linked automatically; later starts only refresh its files.
 */
export async function ensureBridge(): Promise<{ installed: boolean; dir: string; upToDate: boolean }> {
	try {
		const status = await bridgeStatus();
		if (status.installed) {
			// Only rewrite when the shipped Luau actually differs. A window plugin is compiled at
			// window start, so a stale copy silently keeps running old code — hence the version check
			// rather than a blind reinstall on every session start.
			if (!status.upToDate) {
				installBridgeFiles();
				await runTern(["plugin", "reload"], 30000);
			}
			return { installed: false, dir: bridgeDir(), upToDate: status.upToDate };
		}
	} catch {
		/* fall through to install */
	}
	const result = await linkBridge();
	return { installed: true, dir: result.dir, upToDate: true };
}
