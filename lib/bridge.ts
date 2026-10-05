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

async function pluginList(): Promise<Array<{ id?: string; status?: string }>> {
	const result = await runTern(["plugin", "list", "--json"], 20000);
	if (result.code !== 0) throw new Error(result.stderr.trim() || `tern plugin list exited ${result.code}`);
	try {
		const parsed = JSON.parse(result.stdout) as { plugins?: Array<{ id?: string; status?: string }> };
		return parsed.plugins ?? [];
	} catch {
		return [];
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
