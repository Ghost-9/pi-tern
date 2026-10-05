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
	now?: Date;
}

export function bridgeDir(): string {
	return path.join(scratchDir(), "pi-bridge");
}

export function buildDashboard(data: DashboardData): string {
	const time = (data.now ?? new Date()).toISOString().slice(11, 19);
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
