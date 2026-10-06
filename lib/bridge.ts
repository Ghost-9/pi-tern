/**
 * pi-bridge: the extension writes a Markdown dashboard; the Tern plugin renders it in a canvas.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BRIDGE_PLUGIN_TOML, BRIDGE_WINDOW_LUAU } from "./bridge-plugin.ts";
import { runTern, scratchDir } from "./tern.ts";

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
		markdown: buildPanelMarkdown(data),
		updatedAt: (data.now ?? new Date()).toISOString(),
	};
	writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
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
	return dir;
}

export async function linkBridge(): Promise<{ dir: string; linkCode: number; reloadCode: number }> {
	const dir = installBridgeFiles();
	const link = await runTern(["plugin", "link", dir], 15000);
	const reload = await runTern(["plugin", "reload"], 30000);
	return { dir, linkCode: link.code, reloadCode: reload.code };
}

async function pluginList(): Promise<Array<{ id?: string; status?: string; problems?: unknown[]; version?: string }>> {
	const result = await runTern(["plugin", "list", "--json"], 20000);
	if (result.code !== 0) throw new Error(result.stderr.trim() || `tern plugin list exited ${result.code}`);
	try {
		const parsed = JSON.parse(result.stdout) as { plugins?: Array<{ id?: string; status?: string; problems?: unknown[]; version?: string }> };
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
		return { installed: true, version: bridge.version, upToDate: bridge.version === expected };
	} catch {
		return { installed: false, upToDate: false };
	}
}

/**
 * One-install promise: pi-tern alone is enough. On first session start inside Tern the
 * bridge plugin is linked automatically; later starts only refresh its files.
 */
export async function ensureBridge(): Promise<{ installed: boolean; dir: string }> {
	try {
		const plugins = await pluginList();
		if (plugins.some((plugin) => plugin.id === "pi-bridge")) {
			installBridgeFiles();
			return { installed: false, dir: bridgeDir() };
		}
	} catch {
		/* fall through to install */
	}
	const result = await linkBridge();
	return { installed: true, dir: result.dir };
}
