/**
 * Type declarations for the native launcher (plain `.mjs`, no build step).
 *
 * These exist so `tsc --noEmit` under `strict` actually checks the launcher rather than typing
 * every import as `any`. Every one of 1.1.5-1.1.7 was a launcher fix, and this directory used to
 * sit outside both the typecheck include and the lint glob.
 *
 * These describe what `native/backend.mjs`, `native/ansi.mjs`, `native/layout.mjs` and
 * `native/tsp.mjs` actually export. `scripts/check-types.sh` fails if a declaration names an
 * export the module does not have, so the two cannot drift apart silently.
 */

/**
 * One op inside a surface frame. Tern addresses these positionally — the first element is the
 * verb (`add` / `del` / `set` / `blob`), and a node descriptor (`{ k, p }`) appears in a fixed
 * slot — so the shape is a tuple, not an object. Slot 4 carries the node on the ops the sink
 * emits; see `docs/TSP-ENCODINGS.md`.
 */
export type FrameOp = [verb: string, ...rest: unknown[]];

/** The `{ k, p }` node descriptor carried in a frame op's node slot. */
export interface FrameNode {
	/** The advertised node kind, e.g. `col`, `rows`, `md`, `image`, `chart`. */
	k?: string;
	/** Node properties. */
	p?: Record<string, unknown>;
	[key: string]: unknown;
}



/** What Tern's `hello` reply tells us about the surface vocabulary. */
export interface Hello {
	cols?: number;
	rows?: number;
	kinds?: string[];
	features?: string[];
	credits?: number;
	ver?: string;
	[key: string]: unknown;
}

/**
 * The live state behind `nativeState()` and `tern_status`. `lastError` is the important one: it
 * records every op Tern rejected, which is the only oracle available for a new node kind.
 */
export interface NativeState {
	active: boolean;
	suspend: boolean;
	editor: boolean;
	surface: string | null;
	seq: number;
	features: string[];
	kinds: number;
	figures: number;
	markdownNodes: number;
	transcriptMode: string;
	lastError: string | null;
}

/** Every sink method reports acceptance the same way: a reason instead of a throw. */
export interface SinkResult {
	ok: boolean;
	reason?: string;
	id?: string;
	[key: string]: unknown;
}

/** pi's editor instance, as far as the sink needs to know about it. */
export interface PiEditor {
	getText(): string;
	submitValue(value: string): void;
}

/** The grid pi's TUI last painted, which the sink turns into a `rows` node. */
export declare class Screen {
	constructor(cols?: number, rows?: number);
	cols: number;
	rows: number;
	write(chunk: string | Uint8Array): void;
	lines(): string[];
	reset(): void;
}

/** The sink pi-tui writes through when native mode is active. */
export interface NativeSink {
	/** False once `fallback()` has handed the terminal back to pi's own interface. */
	active: boolean;
	/** The surface id currently open. */
	readonly surface: string | null;
	nativeState(): NativeState;
	/** Append a Markdown node. This is the path that makes file references clickable. */
	appendMarkdown(input?: { text?: string; id?: string; caption?: string; transcript?: boolean }): SinkResult;
	/** Replace a pinned Markdown node in place — the "live updating diagram" path. */
	markdown(input?: { text?: string; id?: string; caption?: string }): SinkResult;
	/** A native `image` node. Inline bytes: the blob store is a plugin-VM API, not a frame op. */
	figure(input?: { data?: string; mime?: string; caption?: string }): SinkResult;
	/** A native themed chart node. */
	chart(input?: { series?: unknown[]; title?: string; id?: string }): SinkResult;
	/** The right-edge `aside` sheet: a small panel with its own scroll. */
	aside(input?: { markdown?: string; title?: string; link?: string; id?: string; nodeId?: string }): SinkResult;
	showAside(): SinkResult;
	hideAside(): SinkResult;
	/** `md` replaces the rows transcript; `rows` restores the mirror. */
	transcript(mode: string): SinkResult;
	/** Emit a bare frame op list — how the probes test a node kind the sink has no method for. */
	frame(ops: unknown): SinkResult;
	attachEditor(instance: unknown): void;
	/** Strip TSP frames from pty input and route `e` events; returns what pi's TUI should see. */
	handleInput(data: string): string;
	feed(data: string): void;
	flush(): void;
	suspend(): void;
	resume(): void;
	close(): void;
}

export interface CreateNativeSinkOptions {
	hello?: Hello | null;
	recordPath?: string | null;
	title?: string;
	role?: string;
	adopt?: boolean;
	surfaceId?: string | null;
}

export function createNativeSink(options?: CreateNativeSinkOptions): NativeSink;

/** Split pi's screen into the transcript and the pinned dock. */
export function findDockStart(lines: string[]): number;
export function splitDock(lines: string[]): { main: string[]; dock: string[] };
/** The transcript, the composer's input rows, and the status line below the last rule. */
export interface ComposerParts {
	main: string[];
	composer: string[];
	status: string[];
}
/** Null when the screen has no recognisable composer — the caller keeps the rows mirror then. */
export function splitComposer(lines: string[]): ComposerParts | null;

/**
 * Narrow a frame op's node slot to its `{ k, p }` descriptor, or undefined when the op carries
 * no node (a `del`, or a `set` on a region). Lets the strict typecheck read `op[4].k` without a
 * cast, since positional frame ops are otherwise untyped.
 */
export declare function nodeOf(op: FrameOp): FrameNode | undefined;

// native/handshake.mjs — the retry loop and its failure reasons.
/** Whether a handshake is even possible here, and why not when it is not. */
export declare function handshakePossible(env?: Record<string, string | undefined>): {
	ok: boolean;
	reason: string | null;
};
export type ProbeEnv = Record<string, string | undefined>;
export interface ProbeResult {
	hello: Record<string, unknown> | null;
	/**
	 * Why there is no hello. `timeout` (nothing arrived — a race), `no-hello-reply` (the terminal
	 * answered our DA1 sentinel but does not speak TSP), `unexpected-reply:…` (junk that cannot
	 * become a frame), `no-raw-mode:…`, `not-interactive`, `multiplexer`, `disabled`. Null on success.
	 */
	reason: string | null;
	/** Attempts actually made, which is fewer than the budget when an unretryable reason stopped it. */
	attempts: number;
}
/** The named reasons, so a caller can compare rather than match on a string prefix. */
export declare const ProbeReason: {
	timeout: string;
	unexpectedReply: string;
	noHelloReply: string;
	noRawMode: string;
	notInteractive: string;
	disabled: string;
	multiplexer: string;
};
/**
 * The only stream surface the handshake needs. Deliberately minimal rather than NodeJS.ReadStream:
 * the launcher passes the real streams, and a test passes fakes, and neither should have to
 * implement 80 unrelated methods to satisfy a type.
 */
export interface ProbeInput {
	isTTY?: boolean;
	isRaw?: boolean;
	setRawMode?(value: boolean): void;
	on(event: string, handler: (chunk: Buffer | string) => void): void;
	off(event: string, handler: (chunk: Buffer | string) => void): void;
	resume?(): void;
	pause?(): void;
}
export interface ProbeOutput {
	write(chunk: string): unknown;
}
export interface ProbeOptions {
	input?: ProbeInput;
	output?: ProbeOutput;
	attempts?: number;
	timeoutMs?: number;
	backoffMs?: number;
	env?: ProbeEnv;
	onAttempt?: (attempt: number, result: { hello: unknown; reason: string | null }) => void;
}
export declare function probeOnce(options?: {
	input?: ProbeInput;
	output?: ProbeOutput;
	timeoutMs?: number;
}): Promise<{ hello: Record<string, unknown> | null; reason: string | null }>;
/**
 * Retry the handshake, because it is a race: measured on identical panes, one probe got Tern's
 * reply immediately while another got nothing across six retries over 2.4 s.
 */
export declare function probe(options?: ProbeOptions): Promise<ProbeResult>;
/** Record why the handshake failed, so `/tern diagnose` can say more than "it did not engage". */
export declare function recordProbeFailure(stateFile: string, reason: string, attempts: number): void;
export declare function clearProbeFailure(stateFile: string): void;

export const TSP_VERSION: number;
export const TSP_PREFIX: string;
export const ST: string;

export function encodeMessage(verb: string, body: unknown, params?: Record<string, string>): string;
export function encodeHello(app?: string, ver?: string, features?: string[]): string;
/** A decoded TSP message: the one-character verb plus its JSON body. */
export interface TspMessage {
	verb: string;
	body?: Record<string, unknown>;
}
/** `rest` is the partial tail left in the buffer when a message was split across reads. */
export function extractMessages(buffer: string): { messages: TspMessage[]; rest: string };
export function parseMessage(raw: string): TspMessage | null;
export function isHelloReply(message: TspMessage): boolean;
