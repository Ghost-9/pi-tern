#!/usr/bin/env node
/**
 * TSP encoding probe.
 *
 * Tern answers a program's frames with `{"ev":"error","op":N,"msg":...}` for anything
 * it does not accept, which makes the protocol empirically testable rather than
 * guessable. This script sends one candidate encoding per frame, then reports exactly
 * which wire shapes Tern accepted and which it rejected.
 *
 *   tern new tab --keep-open -- sh -lc 'node scripts/tsp-probe.mjs /tmp/probe.log; sleep 20'
 *   cat /tmp/probe.log
 *
 * It writes diagnostics to the log file, never to stdout: stdout is the TSP channel.
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const log = process.argv[2] ?? "/tmp/pi-tern-probe.log";
const pngPath = process.argv[3];
writeFileSync(log, `pi-tern TSP encoding probe — ${new Date().toISOString()}\n`, "utf8");
const note = (message) => appendFileSync(log, `${new Date().toISOString().slice(11, 23)} ${message}\n`);

const ST = "\x1b\\";
const encode = (verb, body, params = {}) => {
	const parts = Object.entries(params).map(([key, value]) => `${key}=${value}`);
	return `\x1b_tsp;${verb}${parts.length ? `;${parts.join(";")}` : ""};${JSON.stringify(body)}${ST}`;
};

const surface = "probe1";
let seq = 0;
const errors = [];
const helloState = { hello: null };

const send = (ops) => {
	seq += 1;
	process.stdout.write(encode("f", { sf: surface, s: seq, ops }));
	note(`frame ${seq}: ${ops.map((op) => `${op[0]}${op[4]?.k ? `/${op[4].k}` : op[2]?.k ? `/${op[2].k}` : ""}`).join(" ")}`);
};

// ── stdin: hello + error events ───────────────────────────────────────────────
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	for (;;) {
		const start = buffer.indexOf("\x1b_tsp;");
		if (start === -1) break;
		const end = buffer.indexOf(ST, start);
		if (end === -1) break;
		const inner = buffer.slice(start + 5, end);
		buffer = buffer.slice(end + 2);
		const semi = inner.indexOf(";");
		const verb = semi === -1 ? inner : inner.slice(0, semi);
		const jsonStart = inner.indexOf("{", semi + 1);
		if (jsonStart === -1) continue;
		try {
			const body = JSON.parse(inner.slice(jsonStart));
			if (verb === "r" && body?.r === "hello") {
				helloState.hello = body;
				note(`HELLO ver=${body.ver} kinds=${(body.kinds ?? []).length} features=${JSON.stringify(body.features)}`);
				draw();
			} else if (verb === "e") {
				if (body?.ev === "error") {
					errors.push(body);
					note(`ERROR op=${body.op} msg=${JSON.stringify(body.msg)}`);
				} else {
					note(`EVENT ${JSON.stringify(body)}`);
				}
			}
		} catch {
			/* ignore malformed frames */
		}
	}
});

process.stdout.write(encode("q", { q: "hello", v: [1], app: "pi", ver: "1.0.0-probe", features: ["edit", "undo", "send"] }));
process.stdout.write("\x1b[c");

// ── one candidate per frame so an `op` index names exactly one thing ──────────
const CASES = [];

function draw() {
	const png = pngPath ? readFileSync(pngPath).toString("base64") : "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
	note("opening surface");
	process.stdout.write(encode("o", { id: surface, mode: "inline", title: "pi-tern probe", role: "pi.session", listen: false }));

	// ops 0..1 are the shared scaffolding: a region root and a rows node.
	send([["add", "main", surface, null, { id: "main", k: "col", c: [] }]]);
	send([["add", "m", "main", null, { id: "m", k: "rows", p: { cols: 90, lines: ["probe"] } }]]);

	const cases = [
		["md node (clickable file:// links)", [["add", "t", "main", null, { id: "t", k: "md", p: { text: "# md\n\n[note](file:///tmp/probe-note.md)" } }]]],
		["image: {data,mime}", [["add", "i1", "main", null, { id: "i1", k: "image", p: { data: png, mime: "image/png" } }]]],
		["image: {blob:{mime,data}}", [["add", "i2", "main", null, { id: "i2", k: "image", p: { blob: { mime: "image/png", data: png } } }]]],
		["blob op: id,mime,data", [["blob", "B1", "image/png", png]]],
		["blob op: mime,data", [["blob", "image/png", png]]],
		["chart node", [["add", "c1", "main", null, { id: "c1", k: "chart", p: { kind: "bars", bars: [{ label: "a", value: 3 }, { label: "b", value: 5 }] } }]]],
		["card node", [["add", "k1", "main", null, { id: "k1", k: "card", c: [{ id: "k1t", k: "text", p: { text: "card body" } }] }]]],
		["aside region + md", [["add", "aside", surface, null, { id: "aside", k: "col", c: [{ id: "an", k: "md", p: { text: "**Aside**\n\n[Open in split](file:///tmp/probe-note.md)" } }] }]]],
		["set rows", [["set", "m", { cols: 90, lines: ["probe", "after"] }]]],
	];
	for (const [name, ops] of cases) {
		CASES.push(name);
		send(ops);
	}

	setTimeout(() => {
		note("");
		note(`accepted/rejected per frame (${errors.length} error event(s)):`);
		for (const [index, [name]] of CASES.entries()) {
			// frames: 0 = region root, 1 = rows, so case N is frame N + 2
			const frame = index + 2;
			const failure = errors.find((error) => error.s === frame);
			note(`  ${failure ? "REJECTED" : "accepted"}  frame ${frame}  ${name}${failure ? `  -> ${failure.msg}` : ""}`);
		}
		note("done");
		process.exit(0);
	}, 2500);
}

setTimeout(() => {
	if (!helloState.hello) {
		note("no hello within 700 ms — drawing anyway");
		draw();
	}
}, 700);
