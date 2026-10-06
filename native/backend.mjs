/**
 * Native Tern sink: reconstructs pi-tui's screen with the ANSI grid and streams
 * it to a TSP surface as `rows` nodes. `listen:false`, so no acks are needed.
 */
import { appendFileSync } from "node:fs";
import { Screen } from "./ansi.mjs";
import { splitDock } from "./layout.mjs";
import { encodeMessage } from "./tsp.mjs";

export function createNativeSink({ hello, recordPath, title = "pi", role = "pi.session" } = {}) {
	const cols = Number(hello?.cols) || process.stdout.columns || 80;
	const rows = Math.max(5, Number(process.stdout.rows) || 24);
	const screen = new Screen(cols, rows);
	const record = (verb, body, params) => {
		if (!recordPath) return;
		try {
			appendFileSync(recordPath, `${JSON.stringify({ t: Date.now(), dir: "out", verb, params: params ?? {}, body })}\n`);
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

	const send = (verb, body, params) => {
		process.stdout.write(encodeMessage(verb, body, params));
		record(verb, body, params);
	};
	const open = () => {
		if (opened) return;
		opened = true;
		surface = `pi${Date.now().toString(36)}`;
		send("o", { id: surface, mode: "inline", title, role, listen: false });
	};

	return {
		active: true,
		get surface() {
			return surface;
		},
		feed(data) {
			screen.write(data);
			dirty = true;
			// Coalesce frames: Tern should not be asked to redraw faster than 10 fps.
			if (data.includes("\x1b[?2026l") && flushTimer === null) {
				flushTimer = setTimeout(() => {
					flushTimer = null;
					if (dirty) this.flush();
				}, 100);
			}
		},
		flush() {
			if (!dirty && seq > 0) return;
			dirty = false;
			const all = screen.lines();
			const { main, dock } = splitDock(all);
			const fingerprint = `${main.join("\n")}\u0000${dock.join("\n")}`;
			if (fingerprint === lastLines) return;
			lastLines = fingerprint;
			open();
			seq += 1;
			const mainNode = { id: "m", k: "rows", p: { cols, lines: main } };
			const dockNode = dock.length > 0 ? { id: "d", k: "rows", p: { cols, lines: dock } } : null;
			const ops =
				seq === 1
					? [
						["add", "main", surface, null, mainNode],
						...(dockNode ? [["add", "dock", surface, null, dockNode]] : []),
					]
					: [["set", "m", { cols, lines: main }], ...(dockNode ? [["set", "d", { cols, lines: dock }]] : [])];
			send("f", { sf: surface, s: seq, ops });
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
}
