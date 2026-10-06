/**
 * Native Tern sink.
 *
 * M1/M2: reconstruct pi-tui's screen with the ANSI grid and stream it as `rows`
 * nodes (transcript in `main`, composer/status in `dock`).
 * M3: once a pi-tui Editor instance is captured, publish the composer as a real
 * `editor` node (sendable), apply Tern's native edit/undo/send events through
 * pi's own editor API, and expose `suspend`/`resume` frame ops.
 *
 * `listen:false`, so no acks are needed.
 */
import { appendFileSync } from "node:fs";
import { Screen } from "./ansi.mjs";
import { splitComposer, splitDock } from "./layout.mjs";
import { encodeMessage } from "./tsp.mjs";

const EDITOR_METHODS = ["render", "handleInput"];
const TSP_PREFIX = "\x1b_tsp;";

export function createNativeSink({ hello, recordPath, title = "pi", role = "pi.session", adopt = false, surfaceId } = {}) {
	const cols = Number(hello?.cols) || process.stdout.columns || 80;
	const rows = Math.max(5, Number(hello?.rows) || process.stdout.rows || 24);
	const features = Array.isArray(hello?.features) ? hello.features.map(String) : [];
	const screen = new Screen(cols, rows);
	const record = (verb, body, params, dir = "out") => {
		if (!recordPath) return;
		try {
			appendFileSync(recordPath, `${JSON.stringify({ t: Date.now(), dir, verb, params: params ?? {}, body })}\n`);
		} catch {
			/* recording is best effort */
		}
	};
	let surface = null;
	let seq = 0;
	let opened = false;
	let closed = false;
	let dirty = false;
	let flushTimer = null;
	let lastLines = "";
	let lastEditor = "";
	let editor = null;
	let mainAdded = Boolean(adopt);
	let dockAdded = false;
	let editorAdded = false;
	let statusAdded = false;
	let suspended = false;
	let inputBuffer = "";
	/** Last TSP error event we saw, so a rejected op is diagnosable instead of silent. */
	let lastError = null;
	let figureSeq = 0;
	let figures = [];

	const send = (verb, body, params) => {
		process.stdout.write(encodeMessage(verb, body, params));
		record(verb, body, params);
	};
	const open = () => {
		if (opened) return;
		opened = true;
		surface = surfaceId || `pi${Date.now().toString(36)}`;
		send("o", { id: surface, mode: "inline", title, role, listen: false, ...(adopt ? { adopt: true } : {}) });
	};
	const schedule = () => {
		if (flushTimer !== null) return;
		flushTimer = setTimeout(() => {
			flushTimer = null;
			if (dirty) sink.flush();
		}, 0);
	};

	/** Wrap a pi-tui Editor class so the live instance can be attached from its render/input path. */
	const captureEditorClass = (cls) => {
		if (!cls || cls.__piTernCapture) return;
		cls.__piTernCapture = true;
		for (const name of EDITOR_METHODS) {
			const desc = Object.getOwnPropertyDescriptor(cls.prototype, name);
			if (!desc || typeof desc.value !== "function") continue;
			const original = desc.value;
			Object.defineProperty(cls.prototype, name, {
				...desc,
				value: function (...args) {
					try {
						sink.attachEditor(this);
					} catch {
						/* never break pi's render */
					}
					return original.apply(this, args);
				},
			});
		}
	};

	/** Current composer text + caret as a UTF-16 offset into the text. */
	const editorState = () => {
		if (!editor) return null;
		try {
			const text = String(editor.getText?.() ?? "");
			const cursor = editor.getCursor?.();
			let offset = 0;
			if (cursor && typeof cursor.line === "number") {
				const lines = text.split("\n");
				for (let i = 0; i < cursor.line && i < lines.length; i += 1) offset += lines[i].length + 1;
				offset += Math.min(cursor.col ?? 0, lines[cursor.line]?.length ?? 0);
			}
			return { text, cursor: offset };
		} catch {
			return null;
		}
	};

	/** Set text and place the caret at a UTF-16 offset (pi-tui only exposes line/col). */
	const setEditorText = (text, cursorOffset) => {
		editor.setText(text);
		const lines = text.split("\n");
		let remaining = Math.max(0, Math.min(cursorOffset, text.length));
		let line = 0;
		while (line < lines.length - 1 && remaining > lines[line].length) {
			remaining -= lines[line].length + 1;
			line += 1;
		}
		try {
			if (editor.state) editor.state.cursorLine = line;
			editor.setCursorCol?.(Math.min(remaining, lines[line].length));
		} catch {
			/* caret placement is best effort */
		}
	};

	const handleEvent = (event) => {
		if (!event || typeof event !== "object") return;
		if (event.sf && surface && event.sf !== surface) return;
		try {
			switch (event.ev) {
				case "send": {
					if (!editor) return;
					const text = String(event.text ?? "");
					if (!text.trim()) return;
					const draft = editor.getText?.() ?? "";
					if (draft.trim() && typeof editor.addToHistory === "function") editor.addToHistory(draft);
					editor.setText(text);
					editor.submitValue?.();
					break;
				}
				case "edit": {
					if (!editor) return;
					const current = String(editor.getText?.() ?? "");
					if (typeof event.len === "number" && event.len !== current.length) return;
					const from = Math.max(0, Math.min(Number(event.from) || 0, current.length));
					const to = Math.max(from, Math.min(Number(event.to) || 0, current.length));
					const text = String(event.text ?? "");
					setEditorText(current.slice(0, from) + text + current.slice(to), Number(event.cursor) || from + text.length);
					break;
				}
				case "undo":
					editor?.undo?.();
					break;
				case "focus":
					/* pi has one composer; nothing to move */
					break;
				case "error": {
					// The document can be rebuilt after Tern restarts or drops a region.
					const msg = String(event.msg ?? "");
					lastError = { at: Date.now(), msg };
					if (msg.includes("unknown id main") || msg.includes("unknown id m")) {
						mainAdded = false;
						figures = [];
					}
					if (msg.includes("unknown id dock")) {
						dockAdded = false;
						editorAdded = false;
						statusAdded = false;
					}
					if (msg.includes("unknown id d")) statusAdded = false;
					if (msg.includes("unknown id e")) editorAdded = false;
					dirty = true;
					schedule();
					return;
				}
				default:
					return;
			}
			dirty = true;
			schedule();
		} catch {
			/* events must never break the TUI */
		}
	};

	const sink = {
		active: true,
		get surface() {
			return surface;
		},
		nativeState() {
			return {
				active: sink.active,
				suspend: suspended,
				editor: Boolean(editor),
				surface,
				seq,
				features,
				figures: figures.length,
				lastError,
			};
		},
		/**
		 * Append an image to the conversation.
		 *
		 * The transcript region (`main`) is already a `col` whose first child is the
		 * `rows` node, so a figure added to `main` lands after the transcript — i.e. it
		 * reads as the newest thing in the conversation.
		 *
		 * The blob wire shape is not yet confirmed against a live Tern, so it is
		 * selectable with PI_TERN_BLOB_OP and every rejection is recorded in
		 * nativeState().lastError. Requires the `blobs` feature in the hello.
		 */
		figure({ data, mime = "image/png", caption } = {}) {
			if (process.env.PI_TERN_INLINE_IMAGES !== "1") {
				return { ok: false, reason: "inline images are opt-in: set PI_TERN_INLINE_IMAGES=1" };
			}
			if (!features.includes("blobs") && process.env.PI_TERN_FORCE !== "1") {
				return { ok: false, reason: "Tern did not advertise the `blobs` feature" };
			}
			if (typeof data !== "string" || data.length === 0) return { ok: false, reason: "no image data" };
			open();
			figureSeq += 1;
			const id = `fig${figureSeq}`;
			const blobId = `b${figureSeq}`;
			const mode = process.env.PI_TERN_BLOB_OP ?? "id-mime-data";
			const ops = [];
			if (mode === "id-mime-data") ops.push(["blob", blobId, mime, data]);
			else if (mode === "mime-data") ops.push(["blob", mime, data]);
			const props = mode === "inline" ? { blob: { mime, data } } : { blob: blobId };
			if (caption) props.caption = String(caption);
			ops.push(["add", id, "main", null, { id, k: "image", p: props }]);
			figures.push(id);
			const keep = Math.max(1, Number(process.env.PI_TERN_INLINE_KEEP) || 3);
			while (figures.length > keep) ops.push(["del", figures.shift()]);
			seq += 1;
			send("f", { sf: surface, s: seq, ops });
			return { ok: true, id, ops: ops.length, mode, features };
		},
		/** Emit a bare frame op list (for probing new Tern node kinds). */
		frame(ops) {
			if (!Array.isArray(ops) || ops.length === 0) return { ok: false, reason: "ops must be a non-empty array" };
			open();
			seq += 1;
			send("f", { sf: surface, s: seq, ops });
			return { ok: true, seq };
		},
		attachEditor(instance) {
			if (!instance || instance === editor) return;
			if (typeof instance.getText !== "function" || typeof instance.submitValue !== "function") return;
			editor = instance;
			dirty = true;
		},
		/** Strip TSP frames from pty input and route `e` events; return what pi's TUI should still see. */
		handleInput(data) {
			if (typeof data !== "string" || !data.includes(TSP_PREFIX)) return data;
			let rest = inputBuffer + data;
			inputBuffer = "";
			let out = "";
			for (;;) {
				const start = rest.indexOf(TSP_PREFIX);
				if (start === -1) break;
				const end = rest.indexOf("\x1b\\", start);
				if (end === -1) {
					inputBuffer = rest.slice(start);
					rest = "";
					break;
				}
				out += rest.slice(0, start);
				const raw = rest.slice(start + TSP_PREFIX.length, end);
				rest = rest.slice(end + 2);
				const semi = raw.indexOf(";");
				const verb = semi === -1 ? raw : raw.slice(0, semi);
				if (verb === "e" && semi !== -1) {
					try {
						const body = JSON.parse(raw.slice(semi + 1));
						record("e", body, {}, "in");
						handleEvent(body);
					} catch {
						/* malformed events are dropped */
					}
				}
			}
			return out + rest;
		},
		feed(data) {
			screen.write(data);
			dirty = true;
			// Coalesce frames: Tern should not be asked to redraw faster than 10 fps.
			if (data.includes("\x1b[?2026l") && flushTimer === null) {
				flushTimer = setTimeout(() => {
					flushTimer = null;
					if (dirty) sink.flush();
				}, 100);
			}
		},
		flush() {
			if (!dirty && seq > 0) return;
			if (!editor) {
				captureEditorClass(globalThis.__piTernEditorClass);
				captureEditorClass(globalThis.__piTernEditorBase);
			}
			dirty = false;
			const all = screen.lines();
			const state = editorState();
			const parts = state ? splitComposer(all) : null;
			const { main, dock } = parts ? { main: parts.main, dock: parts.status } : splitDock(all);
			const fingerprint = `${state ? `${state.text}\u0000${state.cursor}` : ""}\u0001${main.join("\n")}\u0000${dock.join("\n")}`;
			if (fingerprint === lastLines) return;
			lastLines = fingerprint;
			open();
			seq += 1;
			const ops = [];
			// Regions are root nodes added under the surface id; `main`/`dock` are their node ids.
			const mainNode = { id: "m", k: "rows", p: { cols, lines: main } };
			if (!mainAdded) {
				ops.push(["add", "main", surface, null, { id: "main", k: "col", c: [mainNode] }]);
				mainAdded = true;
			} else {
				ops.push(["set", "m", { cols, lines: main }]);
			}
			const editorNode =
				state && parts ? { id: "e", k: "editor", p: { text: state.text, cursor: state.cursor, sendable: true } } : null;
			if (!dockAdded) {
				const children = [];
				if (editorNode) children.push(editorNode);
				if (dock.length > 0) children.push({ id: "d", k: "rows", p: { cols, lines: dock } });
				if (children.length > 0) {
					ops.push(["add", "dock", surface, null, { id: "dock", k: "col", c: children }]);
					dockAdded = true;
					editorAdded = Boolean(editorNode);
					statusAdded = dock.length > 0;
					lastEditor = editorNode ? `${state.text}\u0000${state.cursor}` : "";
				}
			} else {
				if (editorNode) {
					const currentState = `${state.text}\u0000${state.cursor}`;
					if (!editorAdded) {
						ops.push(["add", "e", "dock", statusAdded ? "d" : null, editorNode]);
						editorAdded = true;
						lastEditor = currentState;
					} else if (currentState !== lastEditor) {
						ops.push(["set", "e", { text: state.text, cursor: state.cursor, sendable: true }]);
						lastEditor = currentState;
					}
				} else if (editorAdded) {
					ops.push(["del", "e"]);
					editorAdded = false;
				}
				if (dock.length > 0) {
					if (statusAdded) ops.push(["set", "d", { cols, lines: dock }]);
					else {
						ops.push(["add", "d", "dock", null, { id: "d", k: "rows", p: { cols, lines: dock } }]);
						statusAdded = true;
					}
				} else if (statusAdded) {
					ops.push(["del", "d"]);
					statusAdded = false;
				}
			}
			if (ops.length > 0) send("f", { sf: surface, s: seq, ops });
		},
		suspend() {
			if (!opened || closed || suspended) return false;
			suspended = true;
			seq += 1;
			send("f", { sf: surface, s: seq, ops: [["suspend"]] });
			return true;
		},
		resume() {
			if (!opened || closed || !suspended) return false;
			suspended = false;
			seq += 1;
			send("f", { sf: surface, s: seq, ops: [["resume"]] });
			return true;
		},
		close() {
			if (flushTimer !== null) {
				clearTimeout(flushTimer);
				flushTimer = null;
			}
			if (closed || !opened) return;
			closed = true;
			send("x", { id: surface, keep: true });
		},
	};
	globalThis.__piTernSink = sink;
	return sink;
}
