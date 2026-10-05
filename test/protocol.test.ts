// Protocol and helper tests. No Tern required; runs anywhere with Node >= 22.6.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { asHello, encodeHello, extractTspMessages, normalizeOsc877 } from "../lib/tsp.ts";
import { eventName, parseEventLine } from "../lib/events.ts";
import { encodeFrame, RelayClient } from "../lib/relay.ts";
import { buildDashboard, ensureBridge } from "../lib/bridge.ts";
import { dbQueryGuard } from "../lib/guard.ts";
import { mermaidFromOutput } from "../lib/diagrams.ts";
import { runShellInTern } from "../lib/run.ts";
import { mailbox, mailboxBatch, EXPECTED_PLUGIN_VERSION } from "../lib/mailbox.ts";
import { extractMermaids, messageText, renderMessageMarkdown, summarizeArgs, cleanShellBlock, extractShellBlocks } from "../lib/text.ts";
import { writeDiagram } from "../lib/diagram.ts";

// The exact Tern 0.4.5 reply captured in a live pane (see CHANGELOG 0.1.0).
const HELLO_BODY = JSON.stringify({
	r: "hello",
	v: 1,
	term: "tern",
	ver: "0.4.5",
	kinds: [
		"col", "row", "card", "section", "rule", "spacer", "text", "md", "code", "diff", "ansi",
		"math", "image", "kv", "table", "tree", "badge", "kbd", "icon", "spinner", "shimmer",
		"elapsed", "progress", "rate", "list", "item", "tabs", "editor", "input", "status", "seg",
		"overlay", "toast", "rows", "picker", "prefs", "tool", "checklist", "agent", "chart",
		"meter", "block", "effort", "el",
	],
	features: ["blobs", "settle", "adopt", "dock", "program-palette", "reduce-motion", "aside", "scroll", "styles", "flow"],
	apc: 65536,
	credits: 2,
	cols: 80,
	cell: { w: 1, h: 1 },
	dark: true,
	reduceMotion: false,
});
const RAW_REPLY = `\x1b_tsp;r;${HELLO_BODY}\x1b\\\x1b[?62;52;c`;

test("parses the captured Tern hello reply", () => {
	const parsed = extractTspMessages(RAW_REPLY);
	assert.equal(parsed.messages.length, 1);
	assert.equal(parsed.messages[0].verb, "r");
	const hello = asHello(parsed.messages[0]);
	assert.ok(hello);
	assert.equal(hello.v, 1);
	assert.equal(hello.ver, "0.4.5");
	assert.equal(hello.kinds.length, 44);
	assert.ok(hello.kinds.includes("agent") && hello.kinds.includes("el"));
	assert.ok(hello.features.includes("flow") && hello.features.includes("styles"));
});

test("preserves the DA1 reply that follows the hello", () => {
	assert.ok(extractTspMessages(RAW_REPLY).rest.includes("\x1b[?62;52;c"));
});

test("parses a reply split across reads", () => {
	const half = Math.floor(RAW_REPLY.length / 2);
	let buffer = "";
	const verbs: string[] = [];
	for (const part of [RAW_REPLY.slice(0, half), RAW_REPLY.slice(half)]) {
		buffer += part;
		const out = extractTspMessages(buffer);
		buffer = out.rest;
		verbs.push(...out.messages.map((m) => m.verb));
	}
	assert.deepEqual(verbs, ["r"]);
});

test("encodeHello round-trips and ends with the DA1 sentinel", () => {
	const out = extractTspMessages(encodeHello("pi-test", "0.0.1"));
	assert.equal(out.messages[0]?.verb, "q");
	assert.equal((out.messages[0]?.body as { q?: string })?.q, "hello");
	assert.ok(out.rest.includes("\x1b[c"));
});

test("extracts mermaid fences from prose", () => {
	const text = "Here:\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\nand\n\n```mermaid\ngraph TD\n  X --> Y\n```\n";
	const found = extractMermaids(text);
	assert.equal(found.length, 2);
	assert.match(found[1], /X --> Y/);
	assert.equal(extractMermaids("plain text").length, 0);
});

test("renders a finalized message", () => {
	assert.equal(messageText({ content: [{ type: "text", text: "hi" }] } as never), "hi");
	const rendered = renderMessageMarkdown({
		role: "assistant",
		content: [{ type: "text", text: "answer" }, { type: "toolCall", name: "bash", arguments: { command: "ls" } }],
	} as never);
	assert.match(rendered, /Assistant/);
	assert.match(rendered, /`bash`/);
	assert.match(rendered, /ls/);
});

test("summarizeArgs truncates", () => {
	assert.ok(summarizeArgs({ a: "x".repeat(300) }).endsWith("…"));
});

test("pinned diagrams keep one stable path", () => {
	const first = writeDiagram("flowchart LR; A-->B", "pi-tern test", true);
	const second = writeDiagram("flowchart LR; A-->B", "pi-tern test", true);
	assert.equal(first.path, second.path);
	rmSync(first.path, { force: true });
});

test("extracts and cleans shell fences", () => {
	const text = "Try:\n\n```bash\n$ npm test\n$ npm run build\n```\n\nand\n\n```sh\necho hi\n```\n";
	const blocks = extractShellBlocks(text);
	assert.equal(blocks.length, 2);
	assert.equal(blocks[0], "$ npm test\n$ npm run build");
	assert.equal(cleanShellBlock(blocks[0]), "npm test\n$ npm run build".replace("$ ", ""));
	assert.equal(extractShellBlocks("```ts\nconsole.log(1)\n```").length, 0);
});

test("normalizes ConPTY OSC-877 replies to APC", () => {
	const body =
		'{"r":"hello","v":1,"term":"tern","kinds":["text"],"features":[],"apc":65536,"credits":2}';
	const osc = `\x1b]877;tsp;r;${body}\x1b\\`;
	const out = extractTspMessages(normalizeOsc877(osc));
	assert.equal(out.messages.length, 1);
	assert.equal(out.messages[0].verb, "r");
	// BEL-terminated OSC 877 (ConPTY) is accepted too.
	const bel = `\x1b]877;tsp;r;${body}\x07`;
	assert.equal(extractTspMessages(normalizeOsc877(bel)).messages.length, 1);
});

test("buildDashboard renders the bridge markdown", () => {
	const md = buildDashboard({
		version: "0.4.0",
		tern: "0.4.5",
		model: "deepseek-v4.1-flash",
		context: "42%",
		cwd: "/tmp/x",
		mirror: "off",
		lastDiagram: "/tmp/d.png",
		lastShell: "12:00:00",
		browserTabs: [1, 2],
		toc: ["[12:00:01] 🤖 Assistant — hello"],
		recent: ["shell · 12:00:00"],
		now: new Date("2026-10-06T12:00:00Z"),
	});
	assert.match(md, /pi-tern/);
	assert.match(md, /deepseek-v4\.1-flash/);
	assert.match(md, /```mermaid/);
	assert.match(md, /browser tabs \| 1, 2/);
	assert.match(md, /## Session/);
	assert.match(md, /\[12:00:01\] 🤖 Assistant/);
	assert.match(md, /## Recent activity/);
});

test("ensureBridge links the plugin when missing", async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "pi-tern-bridge-"));
	const bin = path.join(dir, "tern");
	writeFileSync(
		bin,
		`#!/bin/sh
case "$1 $2" in
  "plugin list") echo '{"plugins":[{"id":"other","status":"ready"}]}' ;;
  "plugin link") exit 0 ;;
  "plugin reload") exit 0 ;;
  *) exit 0 ;;
esac
`,
		{ mode: 0o755 },
	);
	const oldPath = process.env.PATH;
	const oldHome = process.env.HOME;
	process.env.PATH = `${dir}:${oldPath}`;
	process.env.HOME = dir;
	try {
		const result = await ensureBridge();
		assert.equal(result.installed, true);
		assert.ok(result.dir.startsWith(dir), result.dir);
	} finally {
		process.env.PATH = oldPath;
		process.env.HOME = oldHome;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("runShellInTern drives new/wait/capture through a fake tern", async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "pi-tern-fake-"));
	const bin = path.join(dir, "tern");
	writeFileSync(
		bin,
		`#!/bin/sh
case "$1 $2" in
  "new tab") echo '{"session":1,"tab":2,"block":42}' ;;
  "wait 42") exit 0 ;;
  "capture 42") echo 'run-ok-fake' ;;
  *) exit 0 ;;
esac
`,
		{ mode: 0o755 },
	);
	const oldPath = process.env.PATH;
	process.env.PATH = `${dir}:${oldPath}`;
	try {
		const result = await runShellInTern("echo hi", {});
		assert.equal(result.block, "42");
		assert.match(result.output, /run-ok-fake/);
		assert.equal(result.timedOut, false);
	} finally {
		process.env.PATH = oldPath;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("mailbox round-trips through a simulated plugin", async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "pi-tern-mb-"));
	const oldHome = process.env.HOME;
	process.env.HOME = dir;
	const requestFile = path.join(dir, ".pi", "agent", "scratch", "pi-tern", "pi-bridge", "request.json");
	const responseFile = path.join(dir, ".pi", "agent", "scratch", "pi-tern", "pi-bridge", "response.json");
	const pending = mailbox("system.ping", {}, 5000);
	const watcher = setInterval(() => {
		try {
			const request = JSON.parse(readFileSync(requestFile, "utf8")) as { id?: string };
			writeFileSync(responseFile, JSON.stringify({ id: request.id, ok: true, v: EXPECTED_PLUGIN_VERSION, result: { pong: true } }));
		} catch {
			/* request not written yet */
		}
	}, 100);
	try {
		const result = await pending;
		assert.equal(result.ok, true);
		assert.deepEqual(result.result, { pong: true });
	} finally {
		clearInterval(watcher);
		process.env.HOME = oldHome;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("mailbox reports a stale plugin version", async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "pi-tern-mbv-"));
	const oldHome = process.env.HOME;
	process.env.HOME = dir;
	const requestFile = path.join(dir, ".pi", "agent", "scratch", "pi-tern", "pi-bridge", "request.json");
	const responseFile = path.join(dir, ".pi", "agent", "scratch", "pi-tern", "pi-bridge", "response.json");
	const pending = mailbox("system.ping", {}, 4000);
	const watcher = setInterval(() => {
		try {
			const request = JSON.parse(readFileSync(requestFile, "utf8")) as { id?: string };
			writeFileSync(responseFile, JSON.stringify({ id: request.id, ok: true, v: "0.1.0", result: {} }));
		} catch {
			/* not yet */
		}
	}, 100);
	try {
		const result = await pending;
		assert.equal(result.ok, false);
		assert.match(String(result.error), /restart/);
	} finally {
		clearInterval(watcher);
		process.env.HOME = oldHome;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("mailboxBatch round-trips several ops in one request", async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "pi-tern-mbb-"));
	const oldHome = process.env.HOME;
	process.env.HOME = dir;
	const requestFile = path.join(dir, ".pi", "agent", "scratch", "pi-tern", "pi-bridge", "request.json");
	const responseFile = path.join(dir, ".pi", "agent", "scratch", "pi-tern", "pi-bridge", "response.json");
	const pending = mailboxBatch([{ op: "system.ping" }, { op: "settings.get", args: { key: "theme" } }], 5000);
	const watcher = setInterval(() => {
		try {
			const request = JSON.parse(readFileSync(requestFile, "utf8")) as { id?: string; args?: { ops?: unknown[] } };
			assert.equal(request.args?.ops?.length, 2);
			writeFileSync(
				responseFile,
				JSON.stringify({
					id: request.id,
					ok: true,
					v: EXPECTED_PLUGIN_VERSION,
					result: { results: [{ ok: true, result: { pong: true } }, { ok: true, result: { value: "System" } }] },
				}),
			);
		} catch {
			/* not yet */
		}
	}, 100);
	try {
		const result = await pending;
		assert.equal(result.ok, true);
		assert.equal(result.results?.length, 2);
		assert.deepEqual(result.results?.[1]?.result, { value: "System" });
	} finally {
		clearInterval(watcher);
		process.env.HOME = oldHome;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("dbQueryGuard blocks credential stores and untouched queries pass", () => {
	assert.equal(dbQueryGuard({ path: "/tmp/app.db", sql: "select * from users", action: "query" }).allowed, true);
	assert.equal(dbQueryGuard({ path: "/tmp/app.db", sql: "select * from auth_credentials", action: "query" }).allowed, false);
	assert.equal(dbQueryGuard({ path: "/Users/x/.omp/agent/agent.db", sql: "select 1", action: "query" }).allowed, false);
	assert.equal(dbQueryGuard({ path: "/Users/x/.omp/agent/agent.db", sql: "select 1", action: "tables" }).allowed, true);
	assert.equal(
		dbQueryGuard({ path: "/Users/x/.omp/agent/agent.db", sql: "select * from auth_credentials", action: "query", allowSecret: true }).allowed,
		true,
	);
});

test("mermaidFromOutput prefers a fence over raw output", () => {
	assert.equal(mermaidFromOutput("noise\n```mermaid\nflowchart LR\n  A-->B\n```\n"), "flowchart LR\n  A-->B");
	assert.equal(mermaidFromOutput("graph TD\n A-->B"), "graph TD\n A-->B");
});

test("parses tern event lines", () => {
	assert.deepEqual(parseEventLine('{"event":"pane_exited","pane":42,"status":0}'), {
		event: "pane_exited",
		pane: 42,
		status: 0,
	});
	assert.equal(parseEventLine("not json"), null);
	assert.equal(parseEventLine(""), null);
	assert.equal(eventName({ event: "pane_spawned" }), "pane_spawned");
	assert.equal(eventName({ kind: "cli" }), "cli");
});

test("relay client reuses one connection and unwraps answers", async () => {
	const socketPath = path.join(os.tmpdir(), `ptr-${process.pid}.sock`);
	rmSync(socketPath, { force: true });
	let connections = 0;
	let ops = 0;
	const server = createServer((socket) => {
		connections++;
		let buffer = Buffer.alloc(0);
		socket.on("data", (chunk: Buffer) => {
			buffer = Buffer.concat([buffer, chunk]);
			for (;;) {
				if (buffer.length < 4) return;
				const size = buffer.readUInt32LE(0);
				if (buffer.length < 4 + size) return;
				const frame = JSON.parse(buffer.subarray(4, 4 + size).toString("utf8"));
				buffer = buffer.subarray(4 + size);
				if (frame.hello) {
					socket.write(encodeFrame({ welcome: {} }));
					continue;
				}
				ops++;
				socket.write(encodeFrame({ id: frame.id, browser: { ok: { op: frame.browser.op, n: ops } } }));
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	try {
		const client = new RelayClient(socketPath);
		const first = await client.request({ op: "state" });
		const second = await client.request({ op: "eval" });
		assert.equal(connections, 1, "one connection for two ops");
		assert.deepEqual(first, { ok: { op: "state", n: 1 } });
		assert.deepEqual(second, { ok: { op: "eval", n: 2 } });
		client.close();
	} finally {
		server.close();
		rmSync(socketPath, { force: true });
	}
});
