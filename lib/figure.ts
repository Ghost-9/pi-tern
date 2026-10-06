/**
 * Figures: charts and diagrams that render natively in Tern.
 *
 * Three routes, cheapest first:
 *
 *   mermaid  - Tern's built-in merman engine renders the diagram type itself
 *              (xychart-beta, pie, gantt, gitGraph, timeline, quadrant, ...).
 *              Vector, theme-aware, pan/zoom lightbox. No browser.
 *   svg      - we generate the SVG (bars, lines, pie, donut, sparkline from plain
 *              data), and Tern's file hub renders it as a native image block
 *              (its mime list includes image/svg+xml). Vector, no browser.
 *   html     - arbitrary HTML/CSS/JS in Tern's WKWebView picture-in-picture, then
 *              `capture` returns a real PNG that pi can read back as an image.
 *
 * Nothing here needs a Tern *pane*: `tern open` and `tern browser` work from
 * anywhere the daemon answers, so a T3-hosted or headless agent can produce them.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { browserOp } from "./browser.ts";
import { type DiagramPlacement, placementArgs, writeDiagram } from "./diagram.ts";
import { type RunResult, readTernEnv, runTern, scratchDir, type TernEnv } from "./tern.ts";

// ── Chart spec → SVG ─────────────────────────────────────────────────────

export interface ChartPoint {
	label: string;
	value: number;
	color?: string;
}

export interface ChartSeries {
	name: string;
	values: number[];
	color?: string;
}

export type ChartSpec =
	| {
			kind?: "bar" | "hbar" | "pie" | "donut";
			title?: string;
			subtitle?: string;
			unit?: string;
			data: ChartPoint[];
	  }
	| {
			kind: "line" | "area";
			title?: string;
			subtitle?: string;
			unit?: string;
			labels: string[];
			series: ChartSeries[];
	  };

const THEME = {
	dark: {
		bg: "#0d1117",
		fg: "#e6edf3",
		muted: "#8b949e",
		grid: "#21262d",
		panel: "#161b22",
		border: "#30363d",
	},
	light: {
		bg: "#ffffff",
		fg: "#1f2328",
		muted: "#656d76",
		grid: "#d8dee4",
		panel: "#f6f8fa",
		border: "#d0d7de",
	},
};

/** Categorical palette, readable on both themes. */
export const PALETTE = ["#58a6ff", "#3fb950", "#d29922", "#f85149", "#a371f7", "#39c5cf", "#db61a2", "#8b949e"];

function esc(value: unknown): string {
	return String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function fmt(value: number): string {
	if (!Number.isFinite(value)) return String(value);
	const abs = Math.abs(value);
	if (abs >= 1e9) return `${(value / 1e9).toFixed(abs >= 1e10 ? 0 : 1)}B`;
	if (abs >= 1e6) return `${(value / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
	if (abs >= 1e4) return `${Math.round(value / 1e3)}k`;
	if (Number.isInteger(value)) return value.toLocaleString("en-US");
	return String(Number(value.toFixed(2)));
}

/** Value labels keep full precision — abbreviating a number the reader needs is a bug. */
function fmtValue(value: number): string {
	if (!Number.isFinite(value)) return String(value);
	if (Number.isInteger(value)) return value.toLocaleString("en-US");
	return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/** A nice round axis maximum so gridlines land on readable numbers. */
export function niceMax(max: number): number {
	if (!Number.isFinite(max) || max <= 0) return 1;
	const exp = Math.floor(Math.log10(max));
	const base = 10 ** exp;
	for (const step of [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10]) {
		if (max <= step * base) return step * base;
	}
	return 10 * base;
}

function text(
	x: number,
	y: number,
	body: string,
	options: { size?: number; anchor?: string; fill?: string; weight?: number; mono?: boolean } = {},
): string {
	const size = options.size ?? 11;
	const anchor = options.anchor ?? "start";
	const fill = options.fill ?? "currentColor";
	const weight = options.weight ?? 400;
	const family = options.mono
		? "ui-monospace, SFMono-Regular, Menlo, monospace"
		: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
	return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" fill="${fill}" font-family="${family}">${esc(body)}</text>`;
}

export interface SvgChartOptions {
	width?: number;
	theme?: "dark" | "light";
}

/** Render a chart spec as a standalone SVG document string. */
export function renderChartSvg(spec: ChartSpec, options: SvgChartOptions = {}): string {
	const kind = spec.kind ?? "hbar";
	const theme = THEME[options.theme ?? "dark"];
	const width = Math.max(280, Math.min(options.width ?? 720, 1600));
	const pad = { top: 52, right: 24, bottom: 28, left: 24 };
	const title = spec.title ? text(0, 0, "") : ""; // placeholder keeps the template flat
	let body = "";
	let height = 220;

	if (kind === "bar" || kind === "hbar") {
		const data = (spec as { data: ChartPoint[] }).data ?? [];
		const max = niceMax(Math.max(...data.map((d) => d.value), 0));
		const rowh = 34;
		const labelWidth = Math.min(230, Math.max(110, ...data.map((d) => String(d.label).length * 6.6)));
		height = pad.top + data.length * rowh + pad.bottom;
		const trackX = pad.left + labelWidth + 12;
		const trackW = width - trackX - pad.right - 86;
		const trackH = 18;
		// axis
		body += `<line x1="${trackX}" y1="${pad.top - 12}" x2="${trackX + trackW}" y2="${pad.top - 12}" stroke="${theme.grid}"/>`;
		body += text(trackX, pad.top - 18, "0", { size: 9, fill: theme.muted });
		body += text(trackX + trackW, pad.top - 18, fmt(max), { size: 9, fill: theme.muted, anchor: "end" });
		body += `<line x1="${trackX + trackW}" y1="${pad.top - 12}" x2="${trackX + trackW}" y2="${height - pad.bottom + 6}" stroke="${theme.grid}" stroke-dasharray="2 3"/>`;
		data.forEach((point, index) => {
			const y = pad.top + index * rowh;
			const colour = point.color ?? PALETTE[index % PALETTE.length];
			const w = Math.max(1.5, (Math.max(0, point.value) / max) * trackW);
			body += text(pad.left, y + trackH * 0.75, point.label, { size: 11.5, fill: theme.fg });
			body += `<rect x="${trackX}" y="${y}" width="${trackW}" height="${trackH}" rx="3" fill="${theme.panel}" stroke="${theme.border}"/>`;
			body += `<rect x="${trackX}" y="${y}" width="${w.toFixed(1)}" height="${trackH}" rx="3" fill="${colour}"/>`;
			body += text(trackX + trackW + 10, y + trackH * 0.75, fmtValue(point.value), {
				size: 11.5,
				fill: theme.fg,
				weight: 600,
				mono: true,
			});
		});
	} else if (kind === "pie" || kind === "donut") {
		const data = ((spec as { data: ChartPoint[] }).data ?? []).filter((d) => d.value > 0);
		const total = data.reduce((sum, d) => sum + d.value, 0) || 1;
		height = Math.max(260, pad.top + 200);
		const cx = 150;
		const cy = height / 2;
		const r = 92;
		const inner = kind === "donut" ? r * 0.58 : 0;
		let angle = -Math.PI / 2;
		data.forEach((point, index) => {
			const sweep = (point.value / total) * Math.PI * 2;
			const colour = point.color ?? PALETTE[index % PALETTE.length];
			const x1 = cx + r * Math.cos(angle);
			const y1 = cy + r * Math.sin(angle);
			const x2 = cx + r * Math.cos(angle + sweep);
			const y2 = cy + r * Math.sin(angle + sweep);
			const large = sweep > Math.PI ? 1 : 0;
			if (inner > 0) {
				const ix1 = cx + inner * Math.cos(angle + sweep);
				const iy1 = cy + inner * Math.sin(angle + sweep);
				const ix2 = cx + inner * Math.cos(angle);
				const iy2 = cy + inner * Math.sin(angle);
				body += `<path d="M ${x1.toFixed(1)} ${y1.toFixed(1)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(1)} ${y2.toFixed(1)} L ${ix1.toFixed(1)} ${iy1.toFixed(1)} A ${inner} ${inner} 0 ${large} 0 ${ix2.toFixed(1)} ${iy2.toFixed(1)} Z" fill="${colour}"/>`;
			} else {
				body += `<path d="M ${cx} ${cy} L ${x1.toFixed(1)} ${y1.toFixed(1)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(1)} ${y2.toFixed(1)} Z" fill="${colour}"/>`;
			}
			angle += sweep;
		});
		let legendY = pad.top + 6;
		data.forEach((point, index) => {
			const colour = point.color ?? PALETTE[index % PALETTE.length];
			const pct = ((point.value / total) * 100).toFixed(1);
			body += `<rect x="292" y="${legendY - 9}" width="10" height="10" rx="2" fill="${colour}"/>`;
			body += text(310, legendY, `${point.label} — ${fmtValue(point.value)} (${pct}%)`, { size: 11.5, fill: theme.fg });
			legendY += 20;
		});
	} else {
		// line / area
		const labels = (spec as { labels: string[] }).labels ?? [];
		const series = (spec as { series: ChartSeries[] }).series ?? [];
		const all = series.flatMap((s) => s.values);
		const max = niceMax(Math.max(...all, 0));
		const min = Math.min(0, ...all);
		const plotH = 200;
		height = pad.top + plotH + 46;
		const plotX = pad.left + 46;
		const plotW = width - plotX - pad.right - 8;
		const plotY = pad.top;
		const sx = (index: number) => plotX + (labels.length <= 1 ? plotW / 2 : (index / (labels.length - 1)) * plotW);
		const sy = (value: number) => plotY + plotH - ((value - min) / (max - min || 1)) * plotH;
		for (let step = 0; step <= 4; step += 1) {
			const value = min + ((max - min) * step) / 4;
			const y = sy(value);
			body += `<line x1="${plotX}" y1="${y.toFixed(1)}" x2="${plotX + plotW}" y2="${y.toFixed(1)}" stroke="${theme.grid}"/>`;
			body += text(plotX - 8, y + 3.5, fmt(value), { size: 9.5, fill: theme.muted, anchor: "end", mono: true });
		}
		series.forEach((line, index) => {
			const colour = line.color ?? PALETTE[index % PALETTE.length];
			const points = line.values.map((value, i) => `${sx(i).toFixed(1)},${sy(value).toFixed(1)}`);
			if ((spec as { kind?: string }).kind === "area") {
				body += `<path d="M ${sx(0).toFixed(1)} ${(plotY + plotH).toFixed(1)} L ${points.join(" L ")} L ${sx(line.values.length - 1).toFixed(1)} ${(plotY + plotH).toFixed(1)} Z" fill="${colour}" fill-opacity="0.18"/>`;
			}
			body += `<polyline points="${points.join(" ")}" fill="none" stroke="${colour}" stroke-width="2" stroke-linejoin="round"/>`;
			line.values.forEach((value, i) => {
				body += `<circle cx="${sx(i).toFixed(1)}" cy="${sy(value).toFixed(1)}" r="2.6" fill="${colour}"/>`;
			});
			body += `<rect x="${pad.left}" y="${pad.top + index * 15 - 10}" width="9" height="9" rx="2" fill="${colour}"/>`;
			body += text(pad.left + 14, pad.top + index * 15 - 1.5, line.name, { size: 10.5, fill: theme.muted });
		});
		const stride = Math.max(1, Math.ceil(labels.length / 12));
		labels.forEach((label, index) => {
			if (index % stride !== 0 && index !== labels.length - 1) return;
			body += text(sx(index), plotY + plotH + 16, label, {
				size: 10,
				fill: theme.muted,
				anchor: index === 0 ? "start" : index === labels.length - 1 ? "end" : "middle",
			});
		});
	}

	const header = spec.title
		? text(pad.left, 22, spec.title, { size: 13, weight: 650, fill: theme.fg }) +
			(spec.subtitle ? text(pad.left, 38, spec.subtitle, { size: 10.5, fill: theme.muted }) : "") +
			(spec.unit ? text(width - pad.right, 22, spec.unit, { size: 10, fill: theme.muted, anchor: "end" }) : "")
		: "";

	return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(spec.title ?? "chart")}">
<rect width="100%" height="100%" fill="${theme.bg}"/>
<g style="color:${theme.fg}">${header}${body}</g>
${title}</svg>`;
}

// ── Figure rendering ────────────────────────────────────────────────────

/** The best local SVG rasterizer available, or undefined when only the browser can do it. */
export function detectRasterizer(): string | undefined {
	const candidates = [
		"/opt/homebrew/bin/rsvg-convert",
		"/usr/local/bin/rsvg-convert",
		"/usr/bin/rsvg-convert",
		"/opt/homebrew/bin/inkscape",
		"/usr/local/bin/inkscape",
		"/usr/bin/qlmanage",
	];
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate.split("/").pop() as string;
	}
	return undefined;
}

/**
 * Rasterize an SVG without a browser.
 *
 * Order matters: `rsvg-convert` gives an exact-size image and needs no window at
 * all, `qlmanage` ships with macOS, and the Tern browser is the last resort — it
 * needs a *visible* picture-in-picture and returns 0×0 when the window is behind
 * something else.
 */
export async function rasterizeSvg(
	file: string,
	options: { width?: number; timeoutMs?: number } = {},
): Promise<FigurePng | undefined> {
	const width = Math.max(240, Math.min(options.width ?? 1200, 4000));
	const timeoutMs = options.timeoutMs ?? 30000;
	const target = file.replace(/\.svg$/i, ".png");
	const tools: Array<{ bin: string; args: string[]; output: string }> = [
		{ bin: "rsvg-convert", args: ["-w", String(width), "-o", target, file], output: target },
		{ bin: "inkscape", args: [file, `--export-filename=${target}`, `--export-width=${width}`], output: target },
		{ bin: "qlmanage", args: ["-t", "-s", String(width), "-o", path.dirname(target), file], output: `${file}.png` },
	];
	for (const tool of tools) {
		const result = await new Promise<{ code: number }>((resolve) => {
			execFile(tool.bin, tool.args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error) =>
				resolve({ code: error ? 1 : 0 }),
			);
		});
		if (result.code !== 0) continue;
		try {
			if (tool.output !== target && existsSync(tool.output)) {
				renameSync(tool.output, target);
			}
			const bytes = readFileSync(target);
			if (bytes.length < 200) continue;
			return { file: target, data: bytes.toString("base64"), mime: "image/png" };
		} catch {
			continue;
		}
	}
	return undefined;
}

export interface FigurePng {
	file: string;
	data: string;
	mime: string;
	width?: number;
	height?: number;
}

export interface FigureResult {
	route: "mermaid" | "svg" | "html";
	file: string;
	block?: number;
	placement?: DiagramPlacement;
	png?: FigurePng;
	note?: string;
}

function slug(value: string, fallback = "figure"): string {
	return (
		value
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 48) || fallback
	);
}

/** Open a file (any type Tern can render) and return the block id it landed in. */
export async function openFileBlock(
	file: string,
	placement: DiagramPlacement = "split",
	timeoutMs = 20000,
): Promise<number | undefined> {
	const result: RunResult = await runTern(["open", "--json", ...placementArgs(placement), file], timeoutMs);
	if (result.code !== 0 || result.timedOut) {
		throw new Error(
			result.timedOut ? "tern open timed out" : result.stderr.trim() || `tern open exited ${result.code}`,
		);
	}
	try {
		const parsed = JSON.parse(result.stdout) as { blocks?: number[] };
		return Array.isArray(parsed.blocks) ? parsed.blocks[0] : undefined;
	} catch {
		return undefined;
	}
}

/** A block to float a picture-in-picture over, when pi is not itself in a pane. */
async function ownerBlock(env: TernEnv): Promise<number | undefined> {
	if (env.paneId) return Number(env.paneId);
	const result = await runTern(["ls", "--json"], 15000);
	if (result.code !== 0) return undefined;
	try {
		const parsed = JSON.parse(result.stdout) as unknown;
		const found: number[] = [];
		const walk = (node: unknown): void => {
			if (Array.isArray(node)) {
				for (const item of node) walk(item);
				return;
			}
			if (!node || typeof node !== "object") return;
			const record = node as Record<string, unknown>;
			if (Array.isArray(record.blocks)) {
				for (const block of record.blocks as Array<{ id?: number }>) {
					if (typeof block?.id === "number") found.push(block.id);
				}
			}
			for (const value of Object.values(record)) walk(value);
		};
		walk(parsed);
		return found[0];
	} catch {
		return undefined;
	}
}

/**
 * Open `file` in Tern's browser and screenshot it. Returns the PNG bytes plus the
 * path it was written to, so the caller can hand pi an image content block.
 */
export async function captureFile(
	env: TernEnv,
	file: string,
	options: { owner?: number; timeoutMs?: number; label?: string } = {},
): Promise<FigurePng> {
	const timeoutMs = options.timeoutMs ?? 25000;
	const owner = options.owner ?? (await ownerBlock(env));
	if (owner === undefined) throw new Error("no Tern block to float the preview over (is a Tern window open?)");
	const opened = await browserOp(env, { op: "open", url: `file://${file}`, owner }, 15000);
	const block = (opened.ok as { block?: number } | undefined)?.block;
	if (typeof block !== "number") throw new Error("Tern did not return a browser block id");
	try {
		const deadline = Date.now() + timeoutMs;
		let data: string | undefined;
		let mime = "image/png";
		let width: number | undefined;
		let height: number | undefined;
		let lastError = "capture returned no image";
		while (Date.now() < deadline) {
			try {
				const state = (await browserOp(env, { op: "state", block }, 5000)).ok as
					| { loading?: boolean; width?: number; height?: number }
					| undefined;
				if (state?.loading === false) {
					const answer = (await browserOp(env, { op: "capture", block }, 8000)).ok as
						| { data?: string; mime?: string; width?: number; height?: number }
						| undefined;
					if (answer?.data) {
						data = answer.data;
						mime = answer.mime ?? mime;
						width = answer.width ?? state.width;
						height = answer.height ?? state.height;
						break;
					}
					lastError = "capture returned no image data";
				}
			} catch (error) {
				lastError = error instanceof Error ? error.message : String(error);
			}
			await new Promise((resolve) => setTimeout(resolve, 350));
		}
		if (!data) {
			throw new Error(
				lastError.includes("0×0")
					? `${lastError} — bring the Tern window (or the tab hosting the preview) to the front and retry`
					: `capture failed: ${lastError}`,
			);
		}
		const ext = mime === "image/jpeg" ? "jpg" : "png";
		const target = path.join(scratchDir(), `${slug(options.label ?? "capture", "capture")}-${Date.now()}.${ext}`);
		writeFileSync(target, Buffer.from(data, "base64"));
		return { file: target, data, mime, width, height };
	} finally {
		await browserOp(env, { op: "close", block }, 6000).catch(() => undefined);
	}
}

/**
 * Render a figure. `source` is mermaid text, an SVG document, or an HTML document
 * depending on `route`.
 */
export async function renderFigure(options: {
	route: "mermaid" | "svg" | "html";
	source: string;
	title?: string;
	placement?: DiagramPlacement;
	/** Also produce a PNG the model can see (svg/html routes screenshot the block). */
	png?: boolean;
	open?: boolean;
	label?: string;
	timeoutMs?: number;
}): Promise<FigureResult> {
	const env = readTernEnv();
	const source = options.source?.trim();
	if (!source) throw new Error("figure source is empty");
	const placement = options.placement ?? "split";

	if (options.route === "mermaid") {
		const written = writeDiagram(source, options.title, options.placement === "preview" ? false : true);
		let block: number | undefined;
		if (options.open !== false) block = await openFileBlock(written.path, placement, options.timeoutMs);
		const result: FigureResult = { route: "mermaid", file: written.path, block, placement };
		if (options.png) {
			result.png = await captureFile(env, written.path, { timeoutMs: options.timeoutMs, label: options.title });
		}
		return result;
	}

	const dir = scratchDir();
	mkdirSync(dir, { recursive: true });
	const ext = options.route === "svg" ? "svg" : "html";
	const file = path.join(dir, `${slug(options.label ?? options.title ?? options.route, "figure")}-${Date.now()}.${ext}`);
	const body =
		options.route === "svg"
			? source.startsWith("<svg")
				? source
				: // A bare fragment (paths/shapes) is wrapped so the file is a valid image.
					`<svg xmlns="http://www.w3.org/2000/svg" width="720" height="320" viewBox="0 0 720 320">${source}</svg>`
			: source.startsWith("<!DOCTYPE") || source.startsWith("<html")
				? source
				: `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0">${source}</body></html>`;
	writeFileSync(file, `${body}\n`, "utf8");

	let block: number | undefined;
	if (options.open !== false) {
		block = await openFileBlock(file, placement, options.timeoutMs);
	}
	const result: FigureResult = { route: options.route, file, block, placement };
	if (options.png) {
		// A SVG can be rasterized locally, with no browser and no visible window.
		if (options.route === "svg") {
			const raster = await rasterizeSvg(file, { timeoutMs: options.timeoutMs });
			if (raster) {
				result.png = raster;
				result.note = `rasterized locally (${raster.file})`;
			}
		}
		if (!result.png) {
			try {
				result.png = await captureFile(env, file, { timeoutMs: options.timeoutMs, label: options.label ?? options.title });
				if (!result.note) result.note = "screenshotted from Tern's browser";
			} catch (error) {
				// The block is still opened; only the model-visible image is missing.
				result.note = `no PNG: ${error instanceof Error ? error.message : String(error)}`;
			}
		}
	}
	return result;
}
