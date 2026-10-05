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
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { browserOp } from "./lib/browser.ts";
import { bootstrapControl, capturePane, controlCommand, listPanes } from "./lib/ctl.ts";
import { openDiagram, writeDiagram, type DiagramPlacement } from "./lib/diagram.ts";
import { waitForEvent } from "./lib/events.ts";
import { relayPing } from "./lib/relay.ts";
import { loadState, saveState } from "./lib/state.ts";
import { readTernEnv, runTern, scratchDir, type TernEnv } from "./lib/tern.ts";
import { cleanShellBlock, extractMermaids, extractShellBlocks, messageText, renderMessageMarkdown, renderToolMarkdown } from "./lib/text.ts";
import { asHello, encodeHello, extractTspMessages, isDa1Reply, looksLikeTsp, type TspHello } from "./lib/tsp.ts";

const PI_TERN_VERSION = "0.2.1";

interface ProbeState {
	status: "idle" | "pending" | "confirmed" | "absent" | "timeout";
	hello: TspHello | null;
	probedAt?: number;
}

const probe: ProbeState = { status: "idle", hello: null };
let pendingInput = "";
let probeDeadline: ReturnType<typeof setTimeout> | undefined;
let unsubscribeInput: (() => void) | undefined;
let lastBrowserBlock: number | undefined;

// ── Phase A state ────────────────────────────────────────────────────────
let lastMermaid: { source: string; at: number; hash: string } | null = null;
let lastShell: { source: string; at: number } | null = null;
let mirrorEnabled = process.env.PI_TERN_MIRROR === "1";
let mirrorLines: string[] = [];
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
	if (ctx.mode !== "tui") return;
	if (typeof ctx.ui?.onTerminalInput !== "function") return;
	if (unsubscribeInput) return;

	probe.status = "pending";
	probe.probedAt = Date.now();
	unsubscribeInput = ctx.ui.onTerminalInput((data: string) => {
		// TSP replies arrive as in-band APC strings; possibly split, possibly with DA1 after them.
		if (pendingInput.length > 0 || looksLikeTsp(data)) {
			pendingInput += data;
			const { messages, rest } = extractTspMessages(pendingInput);
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
				if (rest.startsWith("\x1b_tsp") || isDa1Reply(rest)) pendingInput = rest;
				return { consume: true };
			}
			// No complete message yet: hold a partial tsp prefix, pass anything else through.
			if (rest.startsWith("\x1b_tsp")) {
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

function appendMirror(block: string): void {
	if (!mirrorEnabled || !block.trim()) return;
	mirrorLines.push(block.trimEnd() + "\n");
	let total = mirrorLines.reduce((n, line) => n + line.length, 0);
	let trimmed = false;
	while (total > 200_000 && mirrorLines.length > 2) {
		total -= mirrorLines.shift()?.length ?? 0;
		trimmed = true;
	}
	if (trimmed) mirrorLines.splice(1, 0, "_…older mirror content trimmed…_");
	if (mirrorTimer) clearTimeout(mirrorTimer);
	mirrorTimer = setTimeout(() => {
		mirrorTimer = undefined;
		flushMirror();
	}, 400);
}

function flushMirror(): void {
	if (!mirrorEnabled) return;
	try {
		writeFileSync(mirrorFile(), mirrorLines.join("\n"), "utf8");
	} catch {
		/* best effort */
	}
}

function startMirror(ctx: any): void {
	mirrorEnabled = true;
	saveState({ mirror: { enabled: true } });
	if (mirrorLines.length === 0) {
		mirrorLines = ["# π session mirror", "", `_${process.cwd()} · ${new Date().toISOString()}_`, ""];
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

/**
 * Run a shell command in Tern: a new visible pane (default) or an existing one.
 * Returns the pane id and the captured output after the command exits (or the
 * wait window elapses).
 */
async function runShellInTern(
	env: TernEnv,
	command: string,
	options: { block?: string; cwd?: string; waitSeconds?: number } = {},
): Promise<{ block: string; output: string; timedOut: boolean }> {
	const cleaned = cleanShellBlock(command);
	if (!cleaned) throw new Error("empty command");
	if (options.block) {
		const sent = await runTern(["run", options.block, cleaned], 15000);
		if (sent.code !== 0) throw new Error(sent.stderr.trim() || `tern run exited ${sent.code}`);
		return { block: options.block, output: "", timedOut: false };
	}
	const args = ["new", "tab", "--json", "--keep-open"];
	if (options.cwd) args.push("--cwd", options.cwd);
	args.push("--", "sh", "-lc", cleaned);
	const created = await runTern(args, 15000);
	if (created.code !== 0) throw new Error(created.stderr.trim() || `tern new tab exited ${created.code}`);
	let block = "";
	try {
		block = String((JSON.parse(created.stdout) as { block?: number }).block ?? "");
	} catch {
		/* fall through to the error below */
	}
	if (!block) throw new Error(`could not read the new pane id: ${created.stdout.slice(0, 200)}`);
	const waitSeconds = Math.max(1, options.waitSeconds ?? 120);
	const waited = await runTern(
		["wait", block, "--until", "exit", "--timeout", String(waitSeconds)],
		(waitSeconds + 10) * 1000,
	);
	const output = await capturePane(block, {});
	return { block, output: output.trimEnd(), timedOut: waited.code !== 0 || waited.timedOut };
}

export default function piTern(pi: ExtensionAPI) {
	pi.on("session_start", async (_event: unknown, ctx: any) => {
		registerProbe(ctx);
		updateTitle(ctx);
		// pi writes its own startup title; re-apply ours once it has settled.
		setTimeout(() => updateTitle(ctx), 3000);
		const persisted = loadState();
		if (process.env.PI_TERN_MIRROR === "1" || persisted.mirror?.enabled) {
			if (!mirrorEnabled) startMirror(ctx);
			else void openDiagram(mirrorFile(), "split").catch(() => undefined);
		}
	});

	pi.on("message_end", async (event: any) => {
		scanMessageForMermaid(event?.message);
		scanMessageForShell(event?.message);
		if (mirrorEnabled) appendMirror(renderMessageMarkdown(event?.message));
	});

	pi.on("tool_execution_end", async (event: any) => {
		if (mirrorEnabled) appendMirror(renderToolMarkdown(event));
	});

	pi.on("turn_end", async (_event: unknown, ctx: any) => {
		updateTitle(ctx);
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
			"Report whether pi runs inside Tern, the pane ids, the TSP hello reply (kinds, features, credits), the last mermaid seen, and the mirror state. Use before tern_diagram / tern_browser / tern_capture.",
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
			if (params.fromFile) source = readFileSync(source, "utf8");
			if (!source.trim()) throw new Error("empty mermaid source (pass source or set fromTranscript)");
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
			op: Type.String({ description: "open|state|snapshot|act|eval|capture|input|goto|nav|events|close" }),
			url: Type.Optional(Type.String()),
			block: Type.Optional(Type.Number({ description: "Browser block id; defaults to the last opened one" })),
			ref: Type.Optional(Type.String()),
			action: Type.Optional(Type.String()),
			text: Type.Optional(Type.String()),
			keys: Type.Optional(Type.String()),
			script: Type.Optional(Type.String()),
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
			if (params.script !== undefined) raw.script = params.script;
			const timeout = (params.timeoutSeconds ?? 20) * 1000;
			const answer =
				params.op === "capture"
					? await captureWithRetry(env, (raw.block as number | undefined) ?? lastBrowserBlock, timeout)
					: await browserOp(env, raw, timeout);
			const ok = answer.ok as { block?: number; data?: string; mime?: string; width?: number; height?: number } | undefined;
			if (ok && typeof ok.block === "number") lastBrowserBlock = ok.block;
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
				return {
					content: [
						{
							type: "text" as const,
							text: `Tern browser capture ${ok.width ?? "?"}x${ok.height ?? "?"}${saved ? ` → ${file}` : ""}`,
						},
						{ type: "image" as const, data: ok.data, mimeType: ok.mime },
					],
					details: { block: ok.block ?? params.block ?? lastBrowserBlock, width: ok.width, height: ok.height, file: saved ? file : undefined },
				};
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
			"Mirror the conversation to a Markdown file block in Tern (mermaid fences render natively). Actions: on, off, open (focus/reload the block), refresh (flush now), status.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("on"), Type.Literal("off"), Type.Literal("open"), Type.Literal("refresh"), Type.Literal("status")]),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx: any) {
			switch (params.action) {
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
			"Wait for the next Tern daemon event (default pane_exited) with an optional pane filter, and return it. Use to wait for a command, test run or server in another pane instead of polling.",
		parameters: Type.Object({
			events: Type.Optional(Type.String({ description: "Comma-separated event names, default pane_exited" })),
			pane: Type.Optional(Type.Number({ description: "Only events for this pane/block id" })),
			timeoutSeconds: Type.Optional(Type.Number({ description: "Default 120" })),
		}),
		async execute(_id, params) {
			const names = new Set(
				(params.events ?? "pane_exited")
					.split(",")
					.map((name) => name.trim())
					.filter(Boolean),
			);
			const timeoutMs = Math.max(1000, (params.timeoutSeconds ?? 120) * 1000);
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
			const env = readTernEnv();
			let command = params.command ?? "";
			if (params.fromTranscript) {
				if (!lastShell) throw new Error("no bash/sh block seen in the conversation yet");
				command = lastShell.source;
			}
			if (!command.trim()) throw new Error("empty command (pass command or set fromTranscript)");
			const result = await runShellInTern(env, command, {
				block: params.block,
				cwd: params.cwd,
				waitSeconds: params.waitSeconds,
			});
			const output = result.output.length > 20000 ? result.output.slice(-20000) : result.output;
			return asText(`${result.timedOut ? "still running" : "done"} · pane ${result.block}\n\n${output || "(no output)"}`);
		},
	});

	pi.registerTool(statusTool);
	pi.registerTool(diagramTool);
	pi.registerTool(browserTool);
	pi.registerTool(captureTool);
	pi.registerTool(panesTool);
	pi.registerTool(ctlTool);
	pi.registerTool(mirrorTool);
	pi.registerTool(watchTool);
	pi.registerTool(diagnoseTool);
	pi.registerTool(runTool);

	// ── Command ────────────────────────────────────────────────────────────

	pi.registerCommand("tern", {
		description:
			"Tern integration: status | diagnose | restore | control [window|headless] | run [--last] <cmd> | title | bell | diagram [--last] [--pin] <mermaid> | mirror on|off|open|status | browser <json> | capture [block] | panes",
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
						const result = await runShellInTern(readTernEnv(), command, { block });
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
						} else if (action === "refresh") {
							flushMirror();
							ctx.ui.notify(`session mirror refreshed: ${mirrorFile()}`, "info");
						} else {
							ctx.ui.notify(`mirror: ${mirrorEnabled ? "on" : "off"} (${mirrorFile()})`, "info");
						}
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
