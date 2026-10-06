#!/usr/bin/env node
/**
 * Persistent TSP renderer for visual verification.
 *
 * Draws every node kind pi-tern emits into one surface and then HOLDS, so a screenshot can be
 * taken. Must be the pane's own program (not a child of `sh -lc`) or it will not own the pty and
 * Tern's replies will never reach it.
 *
 *   tern new tab --keep-open -- node scripts/tsp-render.mjs <pngPath> <holdSeconds>
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const pngPath = process.argv[2] ?? "";
const holdSeconds = Number(process.argv[3] ?? 45);
const log = "/tmp/tsp-render.log";
writeFileSync(log, `pi-tern render probe — ${new Date().toISOString()}\n`, "utf8");
const note = (m) => appendFileSync(log, `${new Date().toISOString().slice(11, 23)} ${m}\n`);

const ST = "\x1b\\";
const encode = (verb, body, params = {}) => {
	const parts = Object.entries(params).map(([k, v]) => `${k}=${v}`);
	return `\x1b_tsp;${verb}${parts.length ? `;${parts.join(";")}` : ""};${JSON.stringify(body)}${ST}`;
};

const surface = "probe1";
let seq = 0;
const send = (ops, label) => {
	seq += 1;
	process.stdout.write(encode("f", { sf: surface, s: seq, ops }));
	note(`frame ${seq}: ${label}`);
};

const png = pngPath ? readFileSync(pngPath).toString("base64") : "";

let hello = null;
let buffer = "";
process.stdin.setEncoding("utf8");
// Raw mode is REQUIRED, not cosmetic: a pty in canonical mode buffers input until a newline, and a
// TSP hello reply has none — so the reply just echoes to the screen and the program never sees it.
// pi-tern's native mode gets this for free from pi-tui; a standalone TSP program must ask.
try {
	process.stdin.setRawMode(true);
} catch {
	note("could not set raw mode — hello replies may not arrive");
}
process.stdin.resume();
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
		const brace = inner.indexOf("{", semi + 1);
		if (brace === -1) continue;
		try {
			const body = JSON.parse(inner.slice(brace));
			if (verb === "r" && body?.r === "hello") {
				hello = body;
				note(`HELLO ver=${body.ver} kinds=${(body.kinds ?? []).length} features=${JSON.stringify(body.features)}`);
				draw();
			} else if (verb === "e") {
				note(`EVENT ${JSON.stringify(body)}`);
			}
		} catch {
			/* ignore */
		}
	}
});

// The handshake is retried: Tern occasionally misses a hello sent at the instant the pane spawns,
// and a single 700 ms probe that assumes an answer is why pi-tern's launcher can silently fall back
// to stock pi. Re-sending costs nothing and makes the handshake reliable.
const helloFrame = encode("q", { q: "hello", v: [1], app: "pi", ver: "1.0.0-probe", features: ["edit", "undo", "send"] });
function sendHello() {
	process.stdout.write(helloFrame);
	process.stdout.write("\x1b[c");
}
sendHello();
let helloTries = 1;
const helloTimer = setInterval(() => {
	if (hello || helloTries >= 6) {
		clearInterval(helloTimer);
		return;
	}
	helloTries += 1;
	note(`no hello yet — retry ${helloTries}`);
	sendHello();
}, 400);

let drawn = false;
let asideDrawn = false;
function draw(forceKinds) {
	if (drawn) return;
	drawn = true;
	const kinds = forceKinds ?? hello?.kinds ?? [];

	note("open surface");
	process.stdout.write(encode("o", { id: surface, mode: "inline", title: "pi-tern render test", role: "pi.session", listen: false }));

	// 1 — the region root, under the surface id
	send([["add", "main", surface, null, { id: "main", k: "col", c: [] }]], "region root");

	// 2 — rows (what native mode uses for pi's transcript)
	send(
		[
			[
				"add",
				"m",
				"main",
				null,
				{
					id: "m",
					k: "rows",
					p: {
						cols: 74,
						lines: [
							"pi> this is a rows node — the transcript today",
							"tool: tern_chart  (below: md, image, chart, aside)",
						],
					},
				},
			],
		],
		"rows",
	);

	// 3 — md with a clickable file:// link
	send(
		[
			[
				"add",
				"t1",
				"main",
				null,
				{
					id: "t1",
					k: "md",
					p: {
						text: [
							"### md node",
							"",
							"A markdown node, with a **clickable** link:",
							"[47-pi-tern-extension-mvp.md](/Users/batra/system-memory/pi-harness/47-pi-tern-extension-mvp.md)",
							"",
							"```js",
							"const ok = true; // code fence",
							"```",
						].join("\n"),
					},
				},
			],
		],
		"md",
	);

	// 4 — image with inline bytes
	if (png && kinds.includes("image")) {
		send([["add", "i1", "main", null, { id: "i1", k: "image", p: { data: png, mime: "image/png", caption: "image node (inline png)" } }]], "image");
	}

	// 5 — chart node
	if (kinds.includes("chart")) {
		send(
			[
				[
					"add",
					"c1",
					"main",
					null,
					{
						id: "c1",
						k: "chart",
						p: {
							kind: "bars",
							title: "Prompt tokens per surface",
							bars: [
								{ label: "pi-tern", value: 764 },
								{ label: "T3 bridge", value: 24258 },
							],
						},
					},
				],
			],
			"chart",
		);
	}

	// 6 — card (to compare against a plain md node)
	send([["add", "k1", "main", null, { id: "k1", k: "card", c: [{ id: "k1t", k: "text", p: { text: "card node body" } }] }]], "card");

	// 7 — aside region
	if ((hello?.features ?? []).includes("aside")) {
		send(
			[
				[
					"add",
					"aside",
					surface,
					null,
					{
						id: "aside",
						k: "col",
						c: [
							{
								id: "an",
								k: "md",
								p: {
									text: "**Aside sheet**\n\n[Open in split](/Users/batra/system-memory/pi-harness/47-pi-tern-extension-mvp.md)",
								},
							},
						],
					},
				],
			],
			"aside",
		);
	}

	note("drawn — holding for the screenshot");
}

setTimeout(() => {
	if (!drawn) {
		// No hello: the encoding probe proved these kinds are accepted, so draw them anyway rather
		// than silently skipping the very frames a screenshot is meant to verify.
		note("no hello within 2500 ms — drawing all kinds anyway");
		draw(["image", "chart"]);
	}
}, 2500);

// The aside is a feature, not a kind, so it is drawn from a second timer once the hello is in.
setTimeout(() => {
	if ((hello?.features ?? []).includes("aside")) return;
	if (asideDrawn) return;
	asideDrawn = true;
	note("drawing the aside anyway (no hello features)");
	send(
		[
			[
				"add",
				"aside",
				surface,
				null,
				{ id: "aside", k: "col", c: [{ id: "an", k: "md", p: { text: "**Aside sheet**\n\n[Open in split](/Users/batra/system-memory/pi-harness/47-pi-tern-extension-mvp.md)" } }] },
			],
		],
		"aside (forced)",
	);
}, 3000);

setTimeout(() => {
	note("hold over, exiting");
	process.stdout.write(encode("x", { id: surface, keep: false }));
	process.exit(0);
}, Math.max(5, holdSeconds) * 1000);
