/**
 * pi-tern — Tern Surface Protocol integration for pi (extension-first).
 *
 * Extension-only capabilities, no pi core patch:
 *  - Tern detection (TERM_PROGRAM=tern) and a raw-TTY TSP hello probe
 *    (write via the pty, read the reply through ctx.ui.onTerminalInput);
 *  - live status in Tern chrome: terminal/tab title + optional attention bell;
 *  - diagrams through Tern's built-in Mermaid renderer (`tern open` file blocks),
 *    including `--last` (the newest mermaid fence in the conversation) and
 *    pinned diagrams that update in place;
 *  - a session mirror: the conversation rendered to a Markdown file block;
 *  - Tern's built-in WKWebView browser via the daemon relay ($TERN_PANE_SOCKET)
 *    with a `tern browser` CLI fallback, including image captures pi can see;
 *  - testing/inspection: pane capture and control-endpoint commands.
 *
 * Deliberately NOT here: native pi-tui surfaces (transcript/composer/dock).
 * A pure extension cannot own pi's renderer; that needs the core back-port.
 *
 * Environment switches:
 *   PI_TERN_PROBE=0        no TSP hello probe
 *   PI_TERN_TITLE=0        no terminal/tab title updates
 *   PI_TERN_BELL=1         ring the bell at agent end (default off)
 *   PI_TERN_MIRROR=1       start the session mirror at session start
 *   PI_TERN_DIAGRAM_AUTO=1 auto-open mermaid blocks found in replies
 *   PI_TERN_RELAY=0        use `tern browser` CLI instead of the daemon relay
 *   PI_TERN_FORCE=1        try Tern features outside a Tern pane
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { browserOp } from "./lib/browser.ts";
import { bootstrapControl, capturePane, controlCommand, listPanes, remoteHosts, shotScenarios, waitForText } from "./lib/ctl.ts";
import { openDiagram, writeDiagram, type DiagramPlacement } from "./lib/diagram.ts";
import { waitForEvent } from "./lib/events.ts";
import { bridgeDir, buildDashboard, ensureBridge, linkBridge, writeDashboard } from "./lib/bridge.ts";
import { gitGraphFromLog, mermaidFromOutput, runCommand } from "./lib/diagrams.ts";
import { dbQueryGuard } from "./lib/guard.ts";
import { uiTest } from "./lib/uitest.ts";
import { mailbox } from "./lib/mailbox.ts";
import { relayPing } from "./lib/relay.ts";
import { runShellInTern } from "./lib/run.ts";
import { loadState, saveState } from "./lib/state.ts";
import { insideMultiplexer, readTernEnv, runTern, scratchDir, type TernEnv } from "./lib/tern.ts";
import { cleanShellBlock, extractMermaids, extractShellBlocks, messageText, renderMessageMarkdown, renderToolMarkdown } from "./lib/text.ts";
import { asHello, encodeHello, extractTspMessages, isDa1Reply, looksLikeTsp, normalizeOsc877, type TspHello } from "./lib/tsp.ts";

const PI_TERN_VERSION = "0.9.1";

interface ProbeState {
	status: "idle" | "pending" | "confirmed" | "absent" | "timeout" | "skipped";
	hello: TspHello | null;
	probedAt?: number;
}

const probe: ProbeState = { status: "idle", hello: null };
let pendingInput = "";
let probeDeadline: ReturnType<typeof setTimeout> | undefined;
let unsubscribeInput: (() => void) | undefined;
let lastBrowserBlock: number | undefined;
const browserTabs: number[] = [];

// ── Phase A state ────────────────────────────────────────────────────────
let lastMermaid: { source: string; at: number; hash: string } | null = null;
let lastShell: { source: string; at: number } | null = null;
let mirrorEnabled = process.env.PI_TERN_MIRROR === "1";
let mirrorLines: string[] = [];
let mirrorToc: string[] = [];
let mirrorStartedAt = new Date();
let mirrorWritten = 0;
let mirrorTimer: ReturnType<typeof setTimeout> | undefined;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function describeProbe(): string {
	const env = readTernEnv();
	const lines = [
		`Tern: ${env.inTern ? "yes" : "no"}${env.version ? ` (TERM_PROGRAM_VERSION=${env.version})` : ""}`,
		`pane: ${env.paneId ?? "-"}  socket: ${env.paneSocket ?? "-"}`,
		`window control: ${env.windowSocket ?? "(none — launch Tern with --control for tern_ctl)"}`,
		`TSP probe: ${probe.status}`,
		`title updates: ${process.env.PI_TERN_TITLE === "0" ? "off" : "on"}  bell: ${process.env.PI_TERN_BELL === "1" ? "on" : "off"}  mirror: ${mirrorEnabled ? "on" : "off"}`,
		`control endpoint: ${loadState().control ?? env.windowSocket ?? "(none — /tern control starts one)"}`,
		`last mermaid: ${lastMermaid ? `${lastMermaid.source.length} chars, ${Math.round((Date.now() - lastMermaid.at) / 1000)}s ago` : "none"}`,
	];
	if (probe.hello) {
		const h = probe.hello;
		lines.push(
			`hello: v=${h.v} term=${h.term} ver=${h.ver ?? "?"} apc=${h.apc} credits=${h.credits} cols=${h.cols ?? "?"} dark=${h.dark}`,
			`kinds (${h.kinds.length}): ${h.kinds.join(", ")}`,
			`features: ${h.features.join(", ")}`,
		);
	}
	if (probe.status === "absent") lines.push("note: DA1 answered before any tsp;r — this terminal does not speak TSP.");
	if (probe.status === "timeout") lines.push("note: no reply before the deadline (multiplexer, or Native program surfaces off).");
	return lines.join("\n");
}

function registerProbe(ctx: { mode?: string; ui?: { onTerminalInput?: (h: (data: string) => unknown) => () => void } }): void {
	const env = readTernEnv();
	if (!env.inTern) return;
	if (process.env.PI_TERN_PROBE === "0") return;
	if (insideMultiplexer()) {
		// tmux/screen/zellij swallow APC, so the handshake cannot complete.
		probe.status = "skipped";
		return;
	}
	if (ctx.mode !== "tui") return;
	if (typeof ctx.ui?.onTerminalInput !== "function") return;
	if (unsubscribeInput) return;

	probe.status = "pending";
	probe.probedAt = Date.now();
	unsubscribeInput = ctx.ui.onTerminalInput((data: string) => {
		// TSP replies arrive as in-band APC strings; possibly split, possibly with DA1 after them.
		if (pendingInput.length > 0 || looksLikeTsp(data)) {
			pendingInput += data;
			// Windows ConPTY delivers replies as OSC 877; normalize to APC first.
			const normalized = normalizeOsc877(pendingInput);
			const { messages, rest } = extractTspMessages(normalized);
			pendingInput = "";
			for (const message of messages) {
				const hello = asHello(message);
				if (hello) {
					probe.hello = hello;
					probe.status = "confirmed";
					if (probeDeadline) clearTimeout(probeDeadline);
					probeDeadline = undefined;
				}
			}
			if (messages.length > 0) {
				// Hold a partial next message or the DA1 reply that follows the hello.
				if (rest.startsWith("\x1b_tsp") || rest.startsWith("\x1b]877") || isDa1Reply(rest)) pendingInput = rest;
				return { consume: true };
			}
			// No complete message yet: hold a partial tsp/OSC prefix, pass anything else through.
			if (rest.startsWith("\x1b_tsp") || rest.startsWith("\x1b]877")) {
				pendingInput = rest;
				return { consume: true };
			}
			return { consume: false, data: rest };
		}
		if (isDa1Reply(data) && probe.probedAt && Date.now() - probe.probedAt < 8000) {
			// The DA1 sentinel belongs to our probe: absorb it instead of feeding pi's editor.
			if (probe.status === "pending") probe.status = "absent";
			if (probeDeadline) clearTimeout(probeDeadline);
			probeDeadline = undefined;
			return { consume: true };
		}
		return undefined;
	});

	// Send the hello + DA1 sentinel after the first frames have settled.
	setTimeout(() => {
		try {
			process.stdout.write(encodeHello("pi", PI_TERN_VERSION));
		} catch {
			/* stdout may be gone */
		}
	}, 1200);
	probeDeadline = setTimeout(() => {
		if (probe.status === "pending") probe.status = "timeout";
	}, 5000);
}

// ── Phase A: Tern chrome, diagrams from the transcript, session mirror ────

function updateTitle(ctx: any): void {
	if (process.env.PI_TERN_TITLE === "0" || !readTernEnv().inTern) return;
	try {
		const model = String((ctx?.model as any)?.id ?? (ctx?.model as any)?.name ?? "pi").split("/").pop();
		const usage = ctx?.getContextUsage?.();
		const pct = typeof usage?.percent === "number" ? `${Math.round(usage.percent)}%` : undefined;
		const dir = path.basename(process.cwd()) || "~";
		ctx?.ui?.setTitle?.(`π ${model}${pct ? ` · ${pct}` : ""} · ${dir}`);
	} catch {
		/* title is cosmetic */
	}
}

function ringBell(): void {
	if (process.env.PI_TERN_BELL !== "1" || !readTernEnv().inTern) return;
	try {
		// A bare BEL on the pty pi writes to; Tern surfaces it as pane attention.
		process.stdout.write("\x07");
	} catch {
		/* cosmetic */
	}
}

function hashText(text: string): string {
	let h = 5381;
	for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
	return (h >>> 0).toString(16);
}

function openMermaid(source: string, title: string, pin = false): Promise<{ path: string }> {
	const written = writeDiagram(source, title, pin);
	if (pin) saveState({ lastDiagram: written.path });
	return openDiagram(written.path, "split").then(() => ({ path: written.path }));
}

function scanMessageForMermaid(message: unknown): void {
	const text = messageText(message);
	if (!text || !text.includes("```mermaid")) return;
	const found = extractMermaids(text);
	if (found.length === 0) return;
	const source = found[found.length - 1];
	const hash = hashText(source);
	const isNew = lastMermaid?.hash !== hash;
	lastMermaid = { source, at: Date.now(), hash };
	if (isNew && process.env.PI_TERN_DIAGRAM_AUTO === "1" && readTernEnv().inTern) {
		void openMermaid(source, "auto diagram").catch(() => undefined);
	}
}

/** Remember the newest bash/sh fence so /tern run --last can execute it. */
function scanMessageForShell(message: unknown): void {
	const role = (message as { role?: string } | null | undefined)?.role;
	if (role !== "assistant" && role !== "user") return;
	const text = messageText(message);
	if (!text || !/```(?:bash|sh|shell|zsh|console)/i.test(text)) return;
	const blocks = extractShellBlocks(text);
	if (blocks.length === 0) return;
	const source = cleanShellBlock(blocks[blocks.length - 1]);
	if (source) lastShell = { source, at: Date.now() };
}

function mirrorFile(): string {
	return path.join(scratchDir(), "session-mirror.md");
}

function appendMirror(block: string, tocEntry?: string): void {
	if (!mirrorEnabled || !block.trim()) return;
	mirrorLines.push(block.trimEnd() + "\n");
	if (tocEntry) {
		mirrorToc.push(tocEntry);
		if (mirrorToc.length > 60) mirrorToc.splice(0, mirrorToc.length - 60);
		mirrorWritten = 0;
	}
	let total = mirrorLines.reduce((n, line) => n + line.length, 0);
	let trimmed = false;
	while (total > 200_000 && mirrorLines.length > 2) {
		total -= mirrorLines.shift()?.length ?? 0;
		trimmed = true;
	}
	if (trimmed) {
		mirrorLines.splice(1, 0, "_…older mirror content trimmed…_");
		mirrorWritten = 0;
	}
	if (mirrorTimer) clearTimeout(mirrorTimer);
	mirrorTimer = setTimeout(() => {
		mirrorTimer = undefined;
		flushMirror();
	}, 400);
}

function mirrorHeader(): string {
	const toc =
		mirrorToc.length > 0 ? `## Contents\n${mirrorToc.map((entry) => `- ${entry}`).join("\n")}\n\n---\n\n` : "";
	return `# π session mirror\n\n_${process.cwd()} · ${mirrorStartedAt.toISOString()}_\n\n${toc}`;
}

function flushMirror(): void {
	if (!mirrorEnabled) return;
	try {
		const text = mirrorHeader() + mirrorLines.join("\n");
		if (mirrorWritten > 0 && mirrorWritten <= text.length) {
			appendFileSync(mirrorFile(), text.slice(mirrorWritten), "utf8");
		} else {
			writeFileSync(mirrorFile(), text, "utf8");
		}
		mirrorWritten = text.length;
	} catch {
		/* best effort */
	}
}

function startMirror(ctx: any): void {
	mirrorEnabled = true;
	saveState({ mirror: { enabled: true } });
	if (mirrorLines.length === 0) {
		mirrorWritten = 0;
		mirrorToc = [];
		mirrorStartedAt = new Date();
		mirrorLines = [];
		try {
			const entries = ctx?.sessionManager?.getBranch?.() ?? [];
			if (Array.isArray(entries)) {
				for (const entry of entries) {
					const message = (entry as any)?.message ?? (entry as any)?.entry?.message;
					if (message) appendMirror(renderMessageMarkdown(message));
				}
			}
		} catch {
			/* branch prefill is best-effort */
		}
	}
	appendMirror(`_mirror on (${new Date().toISOString()})_`);
	flushMirror();
	void openDiagram(mirrorFile(), "split").catch(() => undefined);
}

/** Write the Markdown dashboard the pi-bridge Tern canvas renders. */
function refreshBridge(ctx: any): void {
	try {
		const env = readTernEnv();
		const model = String((ctx?.model as any)?.id ?? (ctx?.model as any)?.name ?? "pi").split("/").pop() ?? "pi";
		const usage = ctx?.getContextUsage?.();
		writeDashboard(
			buildDashboard({
				version: PI_TERN_VERSION,
				tern: env.version,
				model,
				context: typeof usage?.percent === "number" ? `${Math.round(usage.percent)}%` : undefined,
				cwd: process.cwd(),
				mirror: mirrorEnabled ? mirrorFile() : "off",
				lastDiagram: loadState().lastDiagram,
				lastShell: lastShell ? new Date(lastShell.at).toISOString().slice(11, 19) : undefined,
				browserTabs: [...browserTabs],
				toc: [...mirrorToc],
				recent: [
					...(lastShell ? [`shell · ${new Date(lastShell.at).toISOString().slice(11, 19)}`] : []),
					...(lastMermaid ? [`diagram · ${new Date(lastMermaid.at).toISOString().slice(11, 19)}`] : []),
					...(mirrorEnabled ? ["mirror · on"] : []),
				],
			}),
		);
	} catch {
		/* best effort */
	}
}

/** One-line TOC entry for a rendered message. */
function tocFromMarkdown(markdown: string, at: Date): string {
	const heading = markdown.split("\n")[0] ?? "";
	const role = heading.replace(/^##\s+/, "").replace(/\s+·\s+[\d:]+$/, "") || "Message";
	const first = markdown
		.split("\n")
		.find((line) => line.trim() && !line.startsWith("#") && !line.startsWith("-") && !line.startsWith("_"));
	const text = (first ?? "").replace(/\s+/g, " ").trim().slice(0, 70);
	return `[${at.toISOString().slice(11, 19)}] ${role}${text ? ` — ${text}` : ""}`;
}

function asText(text: string) {
	return { content: [{ type: "text" as const, text }], details: undefined };
}

/**
 * Capture a browser screenshot with bounded retries: wait for the page to finish
 * loading, then retry on the WebView's 0x0 failure until the deadline.
 */
async function captureWithRetry(
	env: TernEnv,
	block: number | undefined,
	timeoutMs: number,
): Promise<Awaited<ReturnType<typeof browserOp>>> {
	if (block === undefined) throw new Error("browser capture needs a block id (open a page first or pass block)");
	const deadline = Date.now() + timeoutMs;
	let lastError: Error | undefined;
	while (Date.now() < deadline) {
		try {
			const state = await browserOp(env, { op: "state", block }, 5000);
			if ((state.ok as { loading?: boolean } | undefined)?.loading !== false) {
				await sleep(300);
				continue;
			}
			const answer = await browserOp(env, { op: "capture", block }, Math.max(2000, Math.min(8000, deadline - Date.now())));
			if ((answer.ok as { data?: string } | undefined)?.data) return answer;
			lastError = new Error("capture returned no image data");
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
		}
		await sleep(400);
	}
	const message = lastError?.message ?? "capture timed out";
	if (message.includes("0×0")) {
		throw new Error(
			`${message} — Tern's picture-in-picture must be rendered; bring the Tern window or tab that hosts it to the front and retry`,
		);
	}
	throw new Error(`capture failed: ${message}`);
}
export default function piTern(pi: ExtensionAPI) {
	pi.on("session_start", async (_event: unknown, ctx: any) => {
		registerProbe(ctx);
		updateTitle(ctx);
		refreshBridge(ctx);
		// pi writes its own startup title; re-apply ours once it has settled.
		setTimeout(() => updateTitle(ctx), 3000);
		const persisted = loadState();
		if (process.env.PI_TERN_MIRROR === "1" || persisted.mirror?.enabled) {
			if (!mirrorEnabled) startMirror(ctx);
			else void openDiagram(mirrorFile(), "split").catch(() => undefined);
		}
		// One install: pi-tern links the pi-bridge canvas plugin on first use.
		if (process.env.PI_TERN_BRIDGE !== "0" && readTernEnv().inTern) {
			void ensureBridge()
				.then((result) => {
					if (result.installed) ctx.ui?.notify?.("pi-bridge installed — press ctrl+shift+f10 in Tern", "info");
				})
				.catch(() => undefined);
		}
	});

	pi.on("message_end", async (event: any) => {
		scanMessageForMermaid(event?.message);
		scanMessageForShell(event?.message);
		if (mirrorEnabled) {
			const at = new Date();
			const markdown = renderMessageMarkdown(event?.message, at);
			if (markdown) appendMirror(markdown, tocFromMarkdown(markdown, at));
		}
	});

	pi.on("tool_execution_end", async (event: any) => {
		if (mirrorEnabled) appendMirror(renderToolMarkdown(event, new Date()));
	});

	pi.on("turn_end", async (_event: unknown, ctx: any) => {
		updateTitle(ctx);
		refreshBridge(ctx);
	});

	pi.on("agent_end", async () => {
		ringBell();
	});

	pi.on("session_shutdown", async () => {
		if (unsubscribeInput) {
			unsubscribeInput();
			unsubscribeInput = undefined;
		}
		if (mirrorTimer) {
			clearTimeout(mirrorTimer);
			mirrorTimer = undefined;
		}
	});

	// ── Tools ──────────────────────────────────────────────────────────────

	const statusTool = defineTool({
		name: "tern_status",
		label: "Tern status",
		description:
			"Report whether pi runs inside Tern, the pane ids, the TSP hello reply (kinds, features, credits), the last mermaid seen, and the mirror state. More Tern tools are callable from codemode scripts by name (ctx.tools): tern_capture, tern_panes, tern_ctl, tern_mirror, tern_watch, tern_diagnose, tern_shot, tern_remote, tern_bridge, tern_doc, tern_board, tern_carly, tern_notebook, tern_settings.",
		parameters: Type.Object({}),
		async execute() {
			const env = readTernEnv();
			return asText(
				JSON.stringify(
					{
						env,
						probe: { status: probe.status, hello: probe.hello },
						lastMermaid: lastMermaid ? { chars: lastMermaid.source.length, at: lastMermaid.at } : null,
						mirror: { enabled: mirrorEnabled, path: mirrorFile() },
					},
					null,
					2,
				),
			);
		},
	});

	const diagramTool = defineTool({
		name: "tern_diagram",
		label: "Tern diagram",
		description:
			"Render a Mermaid diagram with Tern's built-in merman renderer: writes the source to a Markdown file and opens it in a Tern file block. Set fromTranscript to use the newest mermaid fence already present in the conversation. Set pin to update one diagram in place.",
		parameters: Type.Object({
			source: Type.Optional(Type.String({ description: "Mermaid source, or a file path when fromFile is true" })),
			title: Type.Optional(Type.String({ description: "Optional heading above the diagram" })),
			fromFile: Type.Optional(Type.Boolean({ description: "Treat source as a path to a .mmd/.md file" })),
			fromTranscript: Type.Optional(Type.Boolean({ description: "Use the last mermaid block seen in the conversation" })),
			fromCommand: Type.Optional(Type.String({ description: "Run a shell command and render the first mermaid fence it prints" })),
			git: Type.Optional(Type.Boolean({ description: "Render this git repository's history as a mermaid gitGraph" })),
			cwd: Type.Optional(Type.String({ description: "Working directory for fromCommand/git" })),
			pin: Type.Optional(Type.Boolean({ description: "Keep one stable file path so re-renders update the same block" })),
			placement: Type.Optional(
				Type.Union([Type.Literal("split"), Type.Literal("tab"), Type.Literal("preview")], {
					description: "Where to open the file block (default split right)",
				}),
			),
		}),
		async execute(_id, params) {
			const env = readTernEnv();
			if (!env.inTern && process.env.PI_TERN_FORCE !== "1") {
				throw new Error("tern_diagram needs a Tern pane (TERM_PROGRAM=tern)");
			}
			let source = params.source ?? "";
			if (params.fromTranscript) {
				if (!lastMermaid) throw new Error("no mermaid block in the conversation yet");
				source = lastMermaid.source;
			}
			if (params.git) source = await gitGraphFromLog(params.cwd);
			if (params.fromCommand) {
				const result = await runCommand(params.fromCommand, params.cwd);
				source = mermaidFromOutput(result.output);
			}
			if (params.fromFile) source = readFileSync(source, "utf8");
			if (!source.trim()) throw new Error("empty mermaid source (pass source, fromTranscript, fromCommand or git)");
			const written = writeDiagram(source, params.title, params.pin === true);
			if (params.placement) await openDiagram(written.path, params.placement as DiagramPlacement);
			else await openDiagram(written.path, "split");
			return asText(`Mermaid diagram opened in Tern: ${written.path}`);
		},
	});

	const browserTool = defineTool({
		name: "tern_browser",
		label: "Tern browser",
		description:
			"Drive Tern's built-in WKWebView browser (picture-in-picture over the pane). Ops: open {url}, state, snapshot, act {action,ref,text,keys}, eval {script}, capture (returns a PNG pi can see), input, goto, nav, events, close. Returns the JSON answer.",
		parameters: Type.Object({
			op: Type.String({
				description:
					"open|state|snapshot|act|eval|capture|input|goto|nav|events|close|tabs|tab_close|pdf|network|form",
			}),
			url: Type.Optional(Type.String()),
			block: Type.Optional(Type.Number({ description: "Browser block id; defaults to the last opened one" })),
			ref: Type.Optional(Type.String()),
			action: Type.Optional(Type.String()),
			text: Type.Optional(Type.String()),
			keys: Type.Optional(Type.String()),
			script: Type.Optional(Type.String({ description: "Function source for eval, e.g. \"function(){ return document.title }\"" })),
			fields: Type.Optional(
				Type.Array(
					Type.Object({
						ref: Type.String({ description: "Snapshot ref of the field" }),
						value: Type.Optional(Type.String()),
						action: Type.Optional(Type.String({ description: "fill (default), select, check, uncheck" })),
					}),
					{ description: "form: fields to fill in order" },
				),
			),
			baseline: Type.Optional(
				Type.String({ description: "Save/compare this capture against a named PNG baseline under scratch/baselines" }),
			),
			timeoutSeconds: Type.Optional(Type.Number()),
		}),
		async execute(_id, params) {
			const env = readTernEnv();
			const raw: Record<string, unknown> = { op: params.op };
			if (params.url !== undefined) raw.url = params.url;
			if (params.block !== undefined) raw.block = params.block;
			else if (lastBrowserBlock !== undefined && params.op !== "open") raw.block = lastBrowserBlock;
			if (params.ref !== undefined) raw.ref = params.ref;
			if (params.action !== undefined) raw.action = params.action;
			if (params.text !== undefined) raw.text = params.text;
			if (params.keys !== undefined) raw.keys = params.keys;
			if (params.script !== undefined) raw.function = params.script;
			const timeout = (params.timeoutSeconds ?? 20) * 1000;
			if (params.op === "tabs") {
				const states: unknown[] = [];
				const dead: number[] = [];
				for (const block of browserTabs) {
					try {
						const state = (await browserOp(env, { op: "state", block }, 5000)).ok as
							| { url?: string; title?: string; loading?: boolean }
							| undefined;
						states.push({ block, url: state?.url, title: state?.title, loading: state?.loading });
					} catch {
						dead.push(block);
					}
				}
				for (const block of dead) {
					const index = browserTabs.indexOf(block);
					if (index >= 0) browserTabs.splice(index, 1);
				}
				return asText(JSON.stringify({ tabs: states, last: lastBrowserBlock }, null, 2));
			}
			if (params.op === "tab_close") {
				const block = (raw.block as number | undefined) ?? lastBrowserBlock;
				if (block === undefined) throw new Error("tab_close needs a block id (or an open tab)");
				const answer = await browserOp(env, { op: "close", block }, timeout);
				const index = browserTabs.indexOf(block);
				if (index >= 0) browserTabs.splice(index, 1);
				if (lastBrowserBlock === block) lastBrowserBlock = browserTabs[browserTabs.length - 1];
				return asText(JSON.stringify(answer, null, 2));
			}
			if (params.op === "network") {
				const block = (raw.block as number | undefined) ?? lastBrowserBlock;
				if (block === undefined) throw new Error("network needs a block id (open a page first)");
				// Resource Timing via eval: a HAR-lite snapshot without an extra protocol.
				const fn =
					"function(){ return { url: location.href, title: document.title, entries: performance.getEntriesByType('resource').map(function(e){ return { name: e.name, initiatorType: e.initiatorType, startTime: Math.round(e.startTime), duration: Math.round(e.duration), transferSize: e.transferSize, encodedBodySize: e.encodedBodySize, decodedBodySize: e.decodedBodySize }; }) }; }";
				const result = await browserOp(env, { op: "eval", block, function: fn }, timeout);
				const value = ((result.ok as { value?: { entries?: Array<Record<string, unknown>> } } | undefined)?.value ?? {}) as {
					entries?: Array<Record<string, unknown>>;
				};
				const entries = Array.isArray(value.entries) ? value.entries : [];
				const file = path.join(scratchDir(), `network-${Date.now()}.json`);
				try {
					writeFileSync(file, JSON.stringify({ capturedAt: new Date().toISOString(), ...value }, null, 2));
				} catch {
					/* summary still returns */
				}
				const total = entries.reduce((sum, entry) => sum + (Number(entry.transferSize) || 0), 0);
				const slowest = [...entries]
					.sort((a, b) => (Number(b.duration) || 0) - (Number(a.duration) || 0))
					.slice(0, 5)
					.map((entry) => ({ name: entry.name, ms: entry.duration }));
				return asText(JSON.stringify({ file, count: entries.length, totalTransferBytes: total, slowest }, null, 2));
			}
			if (params.op === "form") {
				const block = (raw.block as number | undefined) ?? lastBrowserBlock;
				const fields = params.fields ?? [];
				if (fields.length === 0) throw new Error("form needs fields: [{ref, value, action?}]",);
				const results: unknown[] = [];
				for (const field of fields) {
					try {
						const answer = await browserOp(
							env,
							{ op: "act", block, action: field.action ?? "fill", ref: field.ref, text: field.value ?? "" },
							timeout,
						);
						results.push({ ref: field.ref, ok: true, answer });
					} catch (error) {
						results.push({
							ref: field.ref,
							ok: false,
							error: error instanceof Error ? error.message : String(error),
						});
					}
				}
				return asText(JSON.stringify({ fields: results }, null, 2));
			}
			let answer: Awaited<ReturnType<typeof browserOp>>;
			try {
				answer =
					params.op === "capture"
						? await captureWithRetry(env, (raw.block as number | undefined) ?? lastBrowserBlock, timeout)
						: await browserOp(env, raw, timeout);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (params.op === "act" && message.includes("not_found")) {
					// Stale ref: refresh the snapshot, then retry the action once.
					await browserOp(env, { op: "snapshot", block: raw.block ?? lastBrowserBlock }, timeout).catch(() => undefined);
					answer = await browserOp(env, raw, timeout);
				} else {
					throw error;
				}
			}
			const ok = answer.ok as { block?: number; data?: string; mime?: string; width?: number; height?: number } | undefined;
			if (ok && typeof ok.block === "number") {
				lastBrowserBlock = ok.block;
				if (params.op === "open" && !browserTabs.includes(ok.block)) browserTabs.push(ok.block);
			}
			// A capture is an image: hand pi the PNG (and keep a copy on disk).
			if (params.op === "capture" && ok?.data && typeof ok.mime === "string" && ok.mime.startsWith("image/")) {
				const ext = ok.mime === "image/png" ? "png" : ok.mime === "image/jpeg" ? "jpg" : "img";
				const file = path.join(scratchDir(), `capture-${Date.now()}.${ext}`);
				let saved = false;
				try {
					writeFileSync(file, Buffer.from(ok.data, "base64"));
					saved = true;
				} catch {
					/* keep the image in the reply anyway */
				}
				let baselineNote = "";
				if (params.baseline) {
					try {
						const dir = path.join(scratchDir(), "baselines");
						mkdirSync(dir, { recursive: true });
						const safe = String(params.baseline).replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 60) || "baseline";
						const target = path.join(dir, `${safe}.png`);
						const bytes = Buffer.from(ok.data, "base64");
						const sha = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
						const previous = existsSync(target)
							? createHash("sha256").update(readFileSync(target)).digest("hex").slice(0, 16)
							: undefined;
						writeFileSync(target, bytes);
						baselineNote = previous
							? previous === sha
								? ` · baseline unchanged (${safe})`
								: ` · baseline changed (${safe})`
							: ` · baseline created (${safe})`;
					} catch {
						baselineNote = " · baseline write failed";
					}
				}
				return {
					content: [
						{
							type: "text" as const,
							text: `Tern browser capture ${ok.width ?? "?"}x${ok.height ?? "?"}${saved ? ` → ${file}` : ""}${baselineNote}`,
						},
						{ type: "image" as const, data: ok.data, mimeType: ok.mime },
					],
					details: { block: ok.block ?? params.block ?? lastBrowserBlock, width: ok.width, height: ok.height, file: saved ? file : undefined, baseline: params.baseline },
				};
			}
			if (params.op === "pdf" && ok?.data && ok.mime === "application/pdf") {
				const file = path.join(scratchDir(), `page-${Date.now()}.pdf`);
				try {
					writeFileSync(file, Buffer.from(ok.data, "base64"));
				} catch {
					/* still report the operation */
				}
				return asText(`Tern browser PDF saved: ${file}`);
			}
			return asText(JSON.stringify(answer, null, 2));
		},
	});

	const captureTool = defineTool({
		name: "tern_capture",
		label: "Tern capture",
		description:
			"Read a Tern pane's visible text (or HTML/ANSI/scrollback/surfaces) for verification. Defaults to the focused pane; pass a block id from tern_panes.",
		parameters: Type.Object({
			block: Type.Optional(Type.String({ description: "Block id; default @focused" })),
			html: Type.Optional(Type.Boolean()),
			ansi: Type.Optional(Type.Boolean()),
			scrollback: Type.Optional(Type.Boolean()),
			surfaces: Type.Optional(Type.Boolean({ description: "Include TSP surface main-region text" })),
		}),
		async execute(_id, params) {
			const text = await capturePane(params.block, {
				html: params.html,
				ansi: params.ansi,
				scrollback: params.scrollback,
				surfaces: params.surfaces,
			});
			const capped = text.length > 50000 ? `${text.slice(0, 50000)}\n… [${text.length - 50000} chars truncated]` : text;
			return asText(capped);
		},
	});

	const panesTool = defineTool({
		name: "tern_panes",
		label: "Tern panes",
		description: "List Tern sessions, tabs and blocks as JSON (ids for tern_capture and tern_browser).",
		parameters: Type.Object({}),
		async execute() {
			return asText(await listPanes());
		},
	});

	const ctlTool = defineTool({
		name: "tern_ctl",
		label: "Tern control",
		description:
			"Run a Tern control-endpoint command (dump, tree, a11y, state, stats, perf, webcall, resize, …) against the window control socket. Requires Tern launched with --control or TERN_WINDOW_SOCKET.",
		parameters: Type.Object({
			command: Type.Array(Type.String(), { description: "e.g. [\"tree\", \"[data-surface='pi.session']\"]" }),
			control: Type.Optional(Type.String({ description: "Control endpoint override" })),
		}),
		async execute(_id, params) {
			const env = readTernEnv();
			return asText(await controlCommand(env, params.command, params.control ?? loadState().control ?? env.windowSocket));
		},
	});

	const mirrorTool = defineTool({
		name: "tern_mirror",
		label: "Tern session mirror",
		description:
			"Mirror the conversation to a Markdown file block in Tern (mermaid fences render natively). Actions: on, off, open (focus/reload the block), refresh (flush now), search {query}, status.",
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("on"),
				Type.Literal("off"),
				Type.Literal("open"),
				Type.Literal("refresh"),
				Type.Literal("search"),
				Type.Literal("status"),
			]),
			query: Type.Optional(Type.String({ description: "search: literal text to find in the mirror" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx: any) {
			switch (params.action) {
				case "search": {
					const query = (params.query ?? "").trim();
					if (!query) throw new Error("mirror search needs a query");
					let text = "";
					try {
						text = readFileSync(mirrorFile(), "utf8");
					} catch {
						return asText(`mirror file not found: ${mirrorFile()}`);
					}
					const matches = text
						.split("\n")
						.filter((line) => line.toLowerCase().includes(query.toLowerCase()));
					return asText(matches.slice(-60).join("\n").slice(0, 8000) || `no matches for ${query}`);
				}
				case "on":
					startMirror(ctx);
					return asText(`session mirror on: ${mirrorFile()}`);
				case "off":
					flushMirror();
					mirrorEnabled = false;
					saveState({ mirror: { enabled: false } });
					return asText("session mirror off");
				case "open": {
					await openDiagram(mirrorFile(), "split").catch(() => {
						throw new Error("could not open the mirror in Tern");
					});
					return asText(`session mirror opened: ${mirrorFile()}`);
				}
				case "refresh":
					flushMirror();
					return asText(`session mirror refreshed: ${mirrorFile()}`);
				default:
					return asText(JSON.stringify({ enabled: mirrorEnabled, path: mirrorFile(), chars: mirrorLines.join("\n").length }, null, 2));
			}
		},
	});

	const watchTool = defineTool({
		name: "tern_watch",
		label: "Tern watch",
		description:
			"Wait for Tern activity. With expect, poll a pane's output until a regex matches (dev servers, builds, prompts) and return the tail. Without expect, wait for the next daemon event (default pane_exited) with an optional pane filter. Use instead of polling.",
		parameters: Type.Object({
			events: Type.Optional(Type.String({ description: "Comma-separated event names, default pane_exited" })),
			pane: Type.Optional(Type.Number({ description: "Only events for this pane/block id" })),
			expect: Type.Optional(Type.String({ description: "Regex to wait for in a pane's output" })),
			block: Type.Optional(Type.String({ description: "Pane to poll with expect (default @focused)" })),
			timeoutSeconds: Type.Optional(Type.Number({ description: "Default 120" })),
		}),
		async execute(_id, params) {
			const timeoutMs = Math.max(1000, (params.timeoutSeconds ?? 120) * 1000);
			if (params.expect) {
				const result = await waitForText(params.block ?? "@focused", params.expect, timeoutMs);
				return asText(
					JSON.stringify(
						{ matched: result.matched, waitedMs: result.waitedMs, tail: result.output.slice(-2000) },
						null,
						2,
					),
				);
			}
			const names = new Set(
				(params.events ?? "pane_exited")
					.split(",")
					.map((name) => name.trim())
					.filter(Boolean),
			);
			const { event, timedOut } = await waitForEvent({
				timeoutMs,
				match: (candidate) => {
					const name = String((candidate as { event?: unknown }).event ?? "");
					if (names.size > 0 && !names.has(name)) return false;
					if (params.pane !== undefined && Number((candidate as { pane?: unknown }).pane) !== params.pane) return false;
					return true;
				},
			});
			if (timedOut) return asText(JSON.stringify({ timedOut: true, waitedMs: timeoutMs }));
			return asText(JSON.stringify(event, null, 2));
		},
	});

	const diagnoseTool = defineTool({
		name: "tern_diagnose",
		label: "Tern diagnose",
		description:
			"Collect Tern integration diagnostics: environment, TSP probe, relay round trip, control endpoint, persisted state and versions.",
		parameters: Type.Object({}),
		async execute() {
			const env = readTernEnv();
			const version = await runTern(["--version"], 5000);
			const relay = env.paneSocket ? await relayPing(env.paneSocket, 5000) : undefined;
			return asText(
				JSON.stringify(
					{
						version: PI_TERN_VERSION,
						env,
						probe: {
							status: probe.status,
							hello: probe.hello
								? { v: probe.hello.v, ver: probe.hello.ver, kinds: probe.hello.kinds.length, features: probe.hello.features }
								: null,
						},
						tern: version?.stdout.trim() ?? null,
						relay,
						control: loadState().control ?? env.windowSocket ?? null,
						state: loadState(),
						mirror: { enabled: mirrorEnabled, path: mirrorFile() },
						lastMermaid: lastMermaid ? { at: lastMermaid.at, chars: lastMermaid.source.length } : null,
					},
					null,
					2,
				),
			);
		},
	});

	const runTool = defineTool({
		name: "tern_run",
		label: "Tern run",
		description:
			"Run a shell command in a visible Tern pane and return its output. Set fromTranscript to run the newest bash/sh code block from the conversation (like tern_diagram --last). The command runs on this machine with pi's permissions; PI_TERN_RUN=0 disables the tool.",
		parameters: Type.Object({
			command: Type.Optional(Type.String({ description: "Shell command to run" })),
			fromTranscript: Type.Optional(Type.Boolean({ description: "Run the newest bash/sh block seen in the conversation" })),
			block: Type.Optional(Type.String({ description: "Type into an existing Tern pane instead of opening a new one" })),
			cwd: Type.Optional(Type.String({ description: "Working directory for a new pane" })),
			waitSeconds: Type.Optional(Type.Number({ description: "How long to wait for exit (default 120)" })),
		}),
		async execute(_id, params) {
			if (process.env.PI_TERN_RUN === "0") throw new Error("tern_run is disabled (PI_TERN_RUN=0)");
			let command = params.command ?? "";
			if (params.fromTranscript) {
				if (!lastShell) throw new Error("no bash/sh block seen in the conversation yet");
				command = lastShell.source;
			}
			if (!command.trim()) throw new Error("empty command (pass command or set fromTranscript)");
			const result = await runShellInTern(command, {
				block: params.block,
				cwd: params.cwd,
				waitSeconds: params.waitSeconds,
			});
			const output = result.output.length > 20000 ? result.output.slice(-20000) : result.output;
			return asText(`${result.timedOut ? "still running" : "done"} · pane ${result.block}\n\n${output || "(no output)"}`);
		},
	});

	const shotTool = defineTool({
		name: "tern_shot",
		label: "Tern shot",
		description:
			"Render Tern scenarios offscreen to PNG + layout JSON (tern shot). Scenario names default to Tern's built-ins (single, split, palette, find, tabs). Useful as golden screenshots for UI checks.",
		parameters: Type.Object({
			scenarios: Type.Optional(Type.Array(Type.String(), { description: "Scenario files, directories or golden names" })),
			outDir: Type.Optional(Type.String({ description: "Output directory (default under scratch/shots)" })),
		}),
		async execute(_id, params) {
			const outDir = params.outDir ?? path.join(scratchDir(), "shots", String(Date.now()));
			const result = await shotScenarios(params.scenarios ?? [], outDir, 180000);
			return asText(
				JSON.stringify(
					{ code: result.code, outDir, files: result.files.slice(0, 100), output: result.output.slice(0, 2000) },
					null,
					2,
				),
			);
		},
	});

	const remoteTool = defineTool({
		name: "tern_remote",
		label: "Tern remote",
		description: "List or discover Tern remote hosts (tern remote hosts|discover). Read-only.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("hosts"), Type.Literal("discover")], { description: "Default hosts" }),
		}),
		async execute(_id, params) {
			return asText(await remoteHosts(params.action));
		},
	});

	const bridgeTool = defineTool({
		name: "tern_bridge",
		label: "Tern bridge",
		description:
			"The pi-bridge Tern canvas: a native Markdown dashboard of this pi session. Actions: install (writes and links the plugin), refresh (rewrite the dashboard), status.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("install"), Type.Literal("refresh"), Type.Literal("status")]),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx: any) {
			if (params.action === "install") {
				refreshBridge(ctx);
				const result = await linkBridge();
				return asText(
					`pi-bridge installed at ${result.dir} (link ${result.linkCode}, reload ${result.reloadCode}); press ctrl+shift+f10 in Tern`,
				);
			}
			if (params.action === "refresh") {
				refreshBridge(ctx);
				return asText("pi-bridge dashboard refreshed");
			}
			return asText(
				JSON.stringify({ dir: bridgeDir(), installed: existsSync(path.join(bridgeDir(), "plugin.toml")) }, null, 2),
			);
		},
	});

	const dbTool = defineTool({
		name: "tern_db",
		label: "Tern database",
		description:
			"SQLite through Tern's own engine. Actions: tables {path}, schema {path, table}, query {path, sql, limit}, exec {path, sql, allowWrite:true}. Read-only unless allowWrite is true.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("tables"), Type.Literal("schema"), Type.Literal("query"), Type.Literal("exec")]),
			path: Type.String({ description: "Absolute path to a SQLite file" }),
			table: Type.Optional(Type.String()),
			sql: Type.Optional(Type.String()),
			limit: Type.Optional(Type.Number()),
			allowWrite: Type.Optional(Type.Boolean({ description: "exec only: open read-write" })),
			allowSecret: Type.Optional(
				Type.Boolean({ description: "Allow queries against credential-looking tables or the agent/models stores" }),
			),
			timeoutSeconds: Type.Optional(Type.Number()),
		}),
		async execute(_id, params) {
			const guard = dbQueryGuard({
				path: params.path,
				sql: params.sql,
				action: params.action,
				allowSecret: params.allowSecret === true,
			});
			if (!guard.allowed) throw new Error(`tern_db refused: ${guard.reason}`);
			const result = await mailbox(
				`db.${params.action}`,
				{
					path: params.path,
					table: params.table,
					sql: params.sql,
					limit: params.limit,
					allowWrite: params.allowWrite === true,
				},
				(params.timeoutSeconds ?? 15) * 1000,
			);
			return asText(JSON.stringify(result, null, 2));
		},
	});

	const docTool = defineTool({
		name: "tern_doc",
		label: "Tern document",
		description:
			"Read and edit Tern documents through cx.docs, including unsaved edits. Actions: read {path, from?, lines?}, outline {path}, search {path, query}, append {path, text}, write {path, text}, newNote {title, text}.",
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("read"),
				Type.Literal("outline"),
				Type.Literal("search"),
				Type.Literal("append"),
				Type.Literal("write"),
				Type.Literal("newNote"),
				Type.Literal("edit"),
			]),
			path: Type.Optional(Type.String()),
			text: Type.Optional(Type.String()),
			query: Type.Optional(Type.String()),
			title: Type.Optional(Type.String()),
			from: Type.Optional(Type.Number()),
			lines: Type.Optional(Type.Number()),
			find: Type.Optional(Type.String()),
			replace: Type.Optional(Type.String()),
			all: Type.Optional(Type.Boolean()),
			line: Type.Optional(Type.Number()),
			insert: Type.Optional(Type.String()),
			heading: Type.Optional(Type.String()),
			append: Type.Optional(Type.String()),
			timeoutSeconds: Type.Optional(Type.Number()),
		}),
		async execute(_id, params) {
			const result = await mailbox(
				`doc.${params.action}`,
				{
					path: params.path,
					text: params.text,
					query: params.query,
					title: params.title,
					from: params.from,
					lines: params.lines,
					find: params.find,
					replace: params.replace,
					all: params.all,
					line: params.line,
					insert: params.insert,
					heading: params.heading,
					append: params.append,
				},
				(params.timeoutSeconds ?? 15) * 1000,
			);
			return asText(JSON.stringify(result, null, 2));
		},
	});

	const boardTool = defineTool({
		name: "tern_board",
		label: "Tern board",
		description:
			"Read and edit a native Tern board (task/Kanban Markdown). Actions: read {board, rows?}, add {board, lane, text, tags?, due?}, move {card, lane, position?}, check {card, done}, addLane {board, title, position?}.",
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("read"),
				Type.Literal("add"),
				Type.Literal("move"),
				Type.Literal("check"),
				Type.Literal("addLane"),
			]),
			board: Type.Optional(Type.String({ description: "Board Markdown path or pane id" })),
			lane: Type.Optional(Type.String()),
			text: Type.Optional(Type.String()),
			card: Type.Optional(Type.String()),
			done: Type.Optional(Type.Boolean()),
			tags: Type.Optional(Type.Array(Type.String())),
			due: Type.Optional(Type.String({ description: "YYYY-MM-DD" })),
			position: Type.Optional(Type.Number()),
			rows: Type.Optional(Type.Number()),
			timeoutSeconds: Type.Optional(Type.Number()),
		}),
		async execute(_id, params) {
			const result = await mailbox(
				`board.${params.action}`,
				{
					board: params.board,
					lane: params.lane,
					text: params.text,
					card: params.card,
					done: params.done,
					tags: params.tags,
					due: params.due,
					position: params.position,
					rows: params.rows,
				},
				(params.timeoutSeconds ?? 15) * 1000,
			);
			return asText(JSON.stringify(result, null, 2));
		},
	});

	const carlyTool = defineTool({
		name: "tern_carly",
		label: "Tern Carly",
		description:
			"Tern's built-in assistant Carly. Actions: ask {text} (opens Carly with a question), schedule {title, when?, on?, prompt?}, tasks, cancel {id}. Carly routes through its own model providers: never send vault, Apple Notes or secret material.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("ask"), Type.Literal("schedule"), Type.Literal("tasks"), Type.Literal("cancel")]),
			text: Type.Optional(Type.String()),
			title: Type.Optional(Type.String()),
			when: Type.Optional(Type.String({ description: "\"every 30m\", \"daily 09:00\", \"weekdays 09:00\", …" })),
			on: Type.Optional(Type.String({ description: "Event trigger: command_finished, pane_closed, …" })),
			prompt: Type.Optional(Type.String()),
			id: Type.Optional(Type.Number()),
			timeoutSeconds: Type.Optional(Type.Number()),
		}),
		async execute(_id, params) {
			const result = await mailbox(
				`carly.${params.action}`,
				{
					text: params.text,
					title: params.title,
					when: params.when,
					on: params.on,
					prompt: params.prompt,
					id: params.id,
				},
				(params.timeoutSeconds ?? 15) * 1000,
			);
			return asText(JSON.stringify(result, null, 2));
		},
	});

	const notebookTool = defineTool({
		name: "tern_notebook",
		label: "Tern notebook",
		description:
			"Read an open Tern notebook block's cells and outputs (path, kernel, cells with source/output MIME). Execution is not exposed by the plugin API; drive it in Tern's UI.",
		parameters: Type.Object({
			pane: Type.Number({ description: "Notebook block id (from tern_panes)" }),
			timeoutSeconds: Type.Optional(Type.Number()),
		}),
		async execute(_id, params) {
			const result = await mailbox("notebook.read", { pane: params.pane }, (params.timeoutSeconds ?? 15) * 1000);
			return asText(JSON.stringify(result, null, 2));
		},
	});

	const settingsTool = defineTool({
		name: "tern_settings",
		label: "Tern settings",
		description:
			"Read Tern's preferences through cx.settings. Actions: get {key}, list {prefix?}, describe {key} (type, enum, range, default, doc).",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("get"), Type.Literal("list"), Type.Literal("describe")]),
			key: Type.Optional(Type.String()),
			prefix: Type.Optional(Type.String()),
			timeoutSeconds: Type.Optional(Type.Number()),
		}),
		async execute(_id, params) {
			const result = await mailbox(
				`settings.${params.action}`,
				{ key: params.key, prefix: params.prefix },
				(params.timeoutSeconds ?? 15) * 1000,
			);
			return asText(JSON.stringify(result, null, 2));
		},
	});

	const uiTestTool = defineTool({
		name: "tern_ui_test",
		label: "Tern UI test",
		description:
			"Render a Tern scenario offscreen with `tern shot`, then optionally assert against a control endpoint (tree/a11y/state/css/webcall/dump/stats). Returns pass/fail with evidence.",
		parameters: Type.Object({
			scenario: Type.String({ description: "Scenario file path (see examples/scenario.sample.txt)" }),
			outDir: Type.Optional(Type.String()),
			control: Type.Optional(Type.String({ description: "Control endpoint; default is the stored one" })),
			assertions: Type.Optional(
				Type.Array(
					Type.Object({
						type: Type.Union([
							Type.Literal("tree"),
							Type.Literal("a11y"),
							Type.Literal("state"),
							Type.Literal("css"),
							Type.Literal("webcall"),
							Type.Literal("dump"),
							Type.Literal("stats"),
						]),
						selector: Type.Optional(Type.String()),
						expect: Type.Optional(Type.String({ description: "Substring the output must contain" })),
					}),
				),
			),
			timeoutSeconds: Type.Optional(Type.Number()),
		}),
		async execute(_id, params) {
			const control = params.control ?? loadState().control ?? readTernEnv().windowSocket;
			const result = await uiTest({
				scenario: params.scenario,
				outDir: params.outDir,
				control,
				assertions: params.assertions,
				timeoutMs: (params.timeoutSeconds ?? 180) * 1000,
			});
			return asText(JSON.stringify(result, null, 2));
		},
	});

	// Prompt-footprint optimization: only the high-frequency core is declared to the
	// model; everything else is reachable from codemode scripts under one namespace.
	const directTools = new Set(["tern_status", "tern_run", "tern_browser"]);
	const ternNamespace = { name: "tern", description: "Tern terminal integration (sessions, browser, data, mirrors)." };
	for (const tool of [
		statusTool,
		diagramTool,
		browserTool,
		captureTool,
		panesTool,
		ctlTool,
		mirrorTool,
		watchTool,
		diagnoseTool,
		runTool,
		shotTool,
		remoteTool,
		bridgeTool,
		dbTool,
		docTool,
		boardTool,
		carlyTool,
		notebookTool,
		settingsTool,
		uiTestTool,
	]) {
		const name = (tool as { name?: string }).name ?? "";
		pi.registerTool(directTools.has(name) ? tool : ({ ...tool, exposure: "deferred", namespace: ternNamespace } as unknown as typeof tool));
	}

	// ── Command ────────────────────────────────────────────────────────────

	pi.registerCommand("tern", {
		description: "Tern integration: status | db | doc | board | run | ask | schedule | bridge | mirror | diagram | browser | settings",
		handler: async (args: string, ctx: any) => {
			const trimmed = (args ?? "").trim();
			const [sub = "status"] = trimmed.split(/\s+/);
			try {
				switch (sub) {
					case "status":
					case "doctor": {
						ctx.ui.notify(describeProbe(), "info");
						return;
					}
					case "diagnose": {
						const env = readTernEnv();
						const version = await runTern(["--version"], 5000);
						const relay = env.paneSocket ? await relayPing(env.paneSocket, 5000) : undefined;
						ctx.ui.notify(
							JSON.stringify(
								{
									version: PI_TERN_VERSION,
									env,
									probe: probe.status,
									tern: version.stdout.trim(),
									relay,
									control: loadState().control ?? null,
									state: loadState(),
									mirror: mirrorEnabled,
								},
								null,
								2,
							),
							"info",
						);
						return;
					}
					case "restore": {
						const persisted = loadState();
						const opened: string[] = [];
						try {
							if (persisted.mirror?.enabled || mirrorEnabled) {
								if (!mirrorEnabled) startMirror(ctx);
								else await openDiagram(mirrorFile(), "split");
								opened.push("mirror");
							}
							if (persisted.lastDiagram) {
								await openDiagram(persisted.lastDiagram, "split");
								opened.push("diagram");
							}
						} catch (error) {
							ctx.ui.notify(`restore: ${error instanceof Error ? error.message : String(error)}`, "warning");
							return;
						}
						ctx.ui.notify(
							opened.length ? `restored: ${opened.join(", ")}` : "nothing to restore (no mirror, no pinned diagram)",
							"info",
						);
						return;
					}
					case "control": {
						const kindArg = trimmed.split(/\s+/)[1];
						const kind = kindArg === "window" || kindArg === "headless" ? kindArg : "headless";
						const socketPath = path.join(scratchDir(), `control-${process.pid}.sock`);
						const endpoint = await bootstrapControl(kind, socketPath);
						saveState({ control: endpoint });
						ctx.ui.notify(`control endpoint ready (${kind}): ${endpoint}`, "info");
						return;
					}
					case "run": {
						if (process.env.PI_TERN_RUN === "0") {
							ctx.ui.notify("tern run is disabled (PI_TERN_RUN=0)", "warning");
							return;
						}
						const rest = trimmed.slice(trimmed.indexOf(sub) + sub.length).trim();
						if (!rest) {
							ctx.ui.notify("usage: /tern run <command>  |  /tern run --last  |  /tern run --block <id> <command>", "warning");
							return;
						}
						let command = rest;
						let block: string | undefined;
						if (rest.startsWith("--last")) {
							if (!lastShell) {
								ctx.ui.notify("no bash/sh block seen yet in this conversation", "warning");
								return;
							}
							command = lastShell.source;
						} else if (rest.startsWith("--block ")) {
							const parts = rest.split(/\s+/);
							block = parts[1];
							command = rest.slice(rest.indexOf(block) + block.length).trim();
						}
						const result = await runShellInTern(command, { block });
						ctx.ui.notify(
							`${result.timedOut ? "still running" : "done"} · pane ${result.block}\n${result.output.slice(-1500) || "(no output)"}`,
							"info",
						);
						return;
					}
					case "title": {
						updateTitle(ctx);
						ctx.ui.notify("title updated", "info");
						return;
					}
					case "bell": {
						const before = process.env.PI_TERN_BELL;
						process.env.PI_TERN_BELL = "1";
						ringBell();
						if (before === undefined) delete process.env.PI_TERN_BELL;
						else process.env.PI_TERN_BELL = before;
						ctx.ui.notify("bell rung (set PI_TERN_BELL=1 for automatic attention bells)", "info");
						return;
					}
					case "diagram": {
						const rest = trimmed.slice(trimmed.indexOf(sub) + sub.length).trim();
						const env = readTernEnv();
						if (!env.inTern && process.env.PI_TERN_FORCE !== "1") {
							ctx.ui.notify("not inside Tern (TERM_PROGRAM=tern)", "warning");
							return;
						}
						if (rest.startsWith("--from ")) {
							const command = rest.slice(7).trim();
							const result = await runCommand(command);
							const opened = await openMermaid(mermaidFromOutput(result.output), "command diagram");
							ctx.ui.notify(`mermaid (from command) opened in Tern: ${opened.path}`, "info");
							return;
						}
						if (rest === "git" || rest.startsWith("git ")) {
							const cwd = rest.slice(4).trim() || undefined;
							const opened = await openMermaid(await gitGraphFromLog(cwd), "git graph");
							ctx.ui.notify(`gitGraph opened in Tern: ${opened.path}`, "info");
							return;
						}
						if (rest.startsWith("--last")) {
							if (!lastMermaid) {
								ctx.ui.notify("no mermaid block seen yet in this conversation", "warning");
								return;
							}
							const pin = rest.includes("--pin");
							const opened = await openMermaid(lastMermaid.source, "transcript diagram", pin);
							ctx.ui.notify(`mermaid (from transcript) opened in Tern: ${opened.path}`, "info");
							return;
						}
						let raw = rest;
						let title: string | undefined;
						let pin = false;
						if (raw.startsWith("--pin")) {
							pin = true;
							raw = raw.slice(5).trim();
						}
						if (!raw || raw.startsWith("--")) {
							ctx.ui.notify("usage: /tern diagram <mermaid>  |  /tern diagram --last [--pin]  |  --file path.md", "warning");
							return;
						}
						let source = raw;
						if (raw.startsWith("--file ")) {
							source = readFileSync(raw.slice(7).trim(), "utf8");
						} else if (raw.startsWith("--title ")) {
							const nl = raw.indexOf("\n");
							title = (nl === -1 ? raw.slice(8) : raw.slice(8, nl)).trim();
							source = nl === -1 ? "" : raw.slice(nl + 1);
						}
						if (!source.trim()) {
							ctx.ui.notify("empty mermaid source", "warning");
							return;
						}
						const opened = await openMermaid(source, title ?? "diagram", pin);
						ctx.ui.notify(`mermaid opened in Tern: ${opened.path}`, "info");
						return;
					}
					case "mirror": {
						const action = trimmed.split(/\s+/)[1] ?? "status";
						if (action === "on") {
							startMirror(ctx);
							ctx.ui.notify(`session mirror on: ${mirrorFile()}`, "info");
						} else if (action === "off") {
							flushMirror();
							mirrorEnabled = false;
							saveState({ mirror: { enabled: false } });
							ctx.ui.notify("session mirror off", "info");
						} else if (action === "open") {
							await openDiagram(mirrorFile(), "split");
							ctx.ui.notify(`session mirror opened: ${mirrorFile()}`, "info");
						} else if (action === "search") {
							const query = trimmed.split(/\s+/).slice(2).join(" ").trim();
							if (!query) {
								ctx.ui.notify("usage: /tern mirror search <text>", "warning");
								return;
							}
							let text = "";
							try {
								text = readFileSync(mirrorFile(), "utf8");
							} catch {
								ctx.ui.notify(`mirror file not found: ${mirrorFile()}`, "warning");
								return;
							}
							const matches = text
								.split("\n")
								.filter((line) => line.toLowerCase().includes(query.toLowerCase()));
							ctx.ui.notify(matches.slice(-40).join("\n").slice(0, 2000) || `no matches for ${query}`, "info");
						} else if (action === "refresh") {
							flushMirror();
							ctx.ui.notify(`session mirror refreshed: ${mirrorFile()}`, "info");
						} else {
							ctx.ui.notify(`mirror: ${mirrorEnabled ? "on" : "off"} (${mirrorFile()})`, "info");
						}
						return;
					}
					case "db": {
						const parts = trimmed.split(/\s+/);
						const dbPath = parts[1];
						const sql = dbPath ? trimmed.slice(trimmed.indexOf(dbPath) + dbPath.length).trim() : "";
						if (!dbPath || !sql) {
							ctx.ui.notify("usage: /tern db <path> <sql>", "warning");
							return;
						}
						const result = await mailbox("db.query", { path: dbPath, sql, limit: 200 }, 15000);
						ctx.ui.notify(JSON.stringify(result).slice(0, 2000), result.ok ? "info" : "error");
						return;
					}
					case "doc": {
						const parts = trimmed.split(/\s+/);
						const action = parts[1] ?? "read";
						const docPath = parts[2];
						if (!docPath) {
							ctx.ui.notify("usage: /tern doc <read|outline|search> <path> [text]", "warning");
							return;
						}
						const text = trimmed.slice(trimmed.indexOf(docPath) + docPath.length).trim();
						const result = await mailbox(`doc.${action}`, { path: docPath, text }, 15000);
						ctx.ui.notify(JSON.stringify(result).slice(0, 2000), result.ok ? "info" : "error");
						return;
					}
					case "board": {
						const parts = trimmed.split(/\s+/);
						const action = parts[1] ?? "read";
						const boardPath = parts[2];
						if (!boardPath) {
							ctx.ui.notify("usage: /tern board read <path>  |  /tern board add <path> <lane> <text>", "warning");
							return;
						}
						if (action === "add") {
							const lane = parts[3] ?? "";
							const text = trimmed.slice(trimmed.indexOf(lane) + lane.length).trim();
							const result = await mailbox("board.add", { board: boardPath, lane, text }, 15000);
							ctx.ui.notify(JSON.stringify(result).slice(0, 2000), result.ok ? "info" : "error");
							return;
						}
						const result = await mailbox(`board.${action}`, { board: boardPath }, 15000);
						ctx.ui.notify(JSON.stringify(result).slice(0, 2000), result.ok ? "info" : "error");
						return;
					}
					case "ask":
					case "remember":
					case "recall": {
						const rest = trimmed.slice(sub.length).trim();
						if (!rest) {
							ctx.ui.notify(`usage: /tern ${sub} <text>`, "warning");
							return;
						}
						const prefix =
							sub === "remember"
								? "Remember this for later (concise): "
								: sub === "recall"
									? "Search your memory and answer: "
									: "";
						const result = await mailbox("carly.ask", { text: prefix + rest }, 15000);
						ctx.ui.notify(
							result.ok
								? "asked Carly (the answer appears in Carly; Carly uses remote providers — never send vault or secret content)"
								: String(result.error),
							result.ok ? "info" : "error",
						);
						return;
					}
					case "schedule": {
						const rest = trimmed.slice(sub.length).trim();
						if (!rest) {
							ctx.ui.notify("usage: /tern schedule <when> | <title>", "warning");
							return;
						}
						const [when, title] = rest.split("|").map((part) => part.trim());
						const result = await mailbox(
							"carly.schedule",
							{ when, title: title || "pi-tern task", prompt: title || "pi-tern task" },
							15000,
						);
						ctx.ui.notify(JSON.stringify(result).slice(0, 1200), result.ok ? "info" : "error");
						return;
					}
					case "tasks": {
						const result = await mailbox("carly.tasks", {}, 15000);
						const tasks = (result.result as { tasks?: unknown[] } | undefined)?.tasks ?? [];
						ctx.ui.notify(
							{
								tasks: tasks.map((task) => {
									const t = task as { id?: number; title?: string; next?: string; paused?: boolean };
									return `#${t.id} ${t.title ?? ""}${t.next ? ` · next ${t.next}` : ""}${t.paused ? " · paused" : ""}`;
								}),
							}
								.tasks.slice(0, 10)
								.join("\n") || "(no tasks)",
							"info",
						);
						return;
					}
					case "cancel": {
						const id = Number(trimmed.split(/\s+/)[1]);
						if (!Number.isFinite(id) || id < 0) {
							ctx.ui.notify("usage: /tern cancel <id>", "warning");
							return;
						}
						const result = await mailbox("carly.cancel", { id }, 15000);
						ctx.ui.notify(JSON.stringify(result).slice(0, 600), result.ok ? "info" : "error");
						return;
					}
					case "settings": {
						const parts = trimmed.split(/\s+/);
						const action = parts[1] ?? "get";
						const key = parts[2] ?? "";
						const result =
							action === "list"
								? await mailbox("settings.list", { prefix: key || undefined }, 15000)
								: await mailbox(`settings.${action}`, { key }, 15000);
						ctx.ui.notify(JSON.stringify(result).slice(0, 2000), result.ok ? "info" : "error");
						return;
					}
					case "ui-test": {
						const parts = trimmed.split(/\s+/);
						const scenario = parts[1];
						if (!scenario) {
							ctx.ui.notify("usage: /tern ui-test <scenario.txt> [expect substring]", "warning");
							return;
						}
						const expect = parts.slice(2).join(" ").trim() || undefined;
						const control = loadState().control ?? readTernEnv().windowSocket;
						const result = await uiTest({
							scenario,
							control,
							assertions: expect ? [{ type: "state", expect }] : undefined,
						});
						ctx.ui.notify(
							JSON.stringify({ passed: result.passed, files: result.files.length, assertions: result.assertions }, null, 2).slice(0, 2000),
							result.passed ? "info" : "warning",
						);
						return;
					}
					case "notebook": {
						const parts = trimmed.split(/\s+/);
						const action = parts[1] ?? "read";
						if (action === "run") {
							const notebook = parts[2];
							if (!notebook) {
								ctx.ui.notify("usage: /tern notebook run <path.ipynb>", "warning");
								return;
							}
							const command =
								process.env.PI_TERN_NOTEBOOK_CMD?.replaceAll("{file}", notebook) ??
								`jupyter nbconvert --to notebook --execute --inplace "${notebook}"`;
							const result = await runShellInTern(command, { waitSeconds: 300 });
							ctx.ui.notify(
								result.timedOut
									? `notebook still running in pane ${result.block}`
									: `notebook executed (pane ${result.block})\n${result.output.slice(-800) || "(no output)"}`,
								result.timedOut ? "warning" : "info",
							);
							return;
						}
						const pane = Number(parts[2]);
						if (!Number.isFinite(pane)) {
							ctx.ui.notify("usage: /tern notebook read <pane>  |  /tern notebook run <path.ipynb>", "warning");
							return;
						}
						const result = await mailbox("notebook.read", { pane }, 15000);
						ctx.ui.notify(JSON.stringify(result).slice(0, 2000), result.ok ? "info" : "error");
						return;
					}
					case "bridge": {
						const action = trimmed.split(/\s+/)[1] ?? "install";
						if (action === "refresh") {
							refreshBridge(ctx);
							ctx.ui.notify("pi-bridge dashboard refreshed", "info");
							return;
						}
						if (action === "status") {
							ctx.ui.notify(
								JSON.stringify({ dir: bridgeDir(), installed: existsSync(path.join(bridgeDir(), "plugin.toml")) }, null, 2),
								"info",
							);
							return;
						}
						refreshBridge(ctx);
						const result = await linkBridge();
						ctx.ui.notify(
							`pi-bridge installed (link ${result.linkCode}, reload ${result.reloadCode}) — press ctrl+shift+f10 in Tern`,
							"info",
						);
						return;
					}
					case "browser": {
						const json = trimmed.slice(trimmed.indexOf(sub) + sub.length).trim();
						if (!json) {
							ctx.ui.notify("usage: /tern browser '{\"op\":\"open\",\"url\":\"…\"}'", "warning");
							return;
						}
						const answer = await browserOp(readTernEnv(), JSON.parse(json));
						ctx.ui.notify(JSON.stringify(answer).slice(0, 1500), "info");
						return;
					}
					case "capture": {
						const block = trimmed.split(/\s+/)[1];
						const text = await capturePane(block, { surfaces: true });
						ctx.ui.notify(text.slice(0, 2000), "info");
						return;
					}
					case "panes": {
						ctx.ui.notify((await listPanes()).slice(0, 4000), "info");
						return;
					}
					default:
						ctx.ui.notify(`unknown /tern subcommand: ${sub} (status|title|bell|diagram|mirror|browser|capture|panes)`, "warning");
				}
			} catch (error) {
				ctx.ui.notify(`tern: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}

// Keep the compiler honest about unused imports used only for types.
export type { DiagramPlacement } from "./lib/diagram.ts";
