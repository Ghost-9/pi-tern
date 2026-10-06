#!/usr/bin/env node
/**
 * Raw-byte handshake probe.
 *
 * Logs EVERY byte that arrives on stdin, so we can tell "Tern never answered" apart from
 * "Tern answered and our parser dropped it". Holds the pane open so it can be screenshotted.
 *
 *   tern new tab --keep-open -- node scripts/hello-probe.mjs <holdSeconds>
 */
import { appendFileSync, writeFileSync } from "node:fs";

const hold = Number(process.argv[2] ?? 45);
const log = "/tmp/hello-probe.log";
writeFileSync(log, `hello probe — ${new Date().toISOString()}\n`, "utf8");
const note = (m) => appendFileSync(log, `${m}\n`);

try {
	process.stdin.setRawMode(true);
	note("raw mode: on");
} catch (error) {
	note(`raw mode FAILED: ${error}`);
}
process.stdin.resume();
note(`isTTY=${process.stdin.isTTY} TERM=${process.env.TERM} TERM_PROGRAM=${process.env.TERM_PROGRAM} pane=${process.env.TERN_PANE}`);

let bytes = 0;
process.stdin.on("data", (chunk) => {
	bytes += chunk.length;
	const text = chunk.toString("utf8");
	note(`READ ${chunk.length} bytes: ${JSON.stringify(text.slice(0, 400))}`);
	const printable = text.replace(/\x1b/g, "\\e");
	if (printable.includes("hello")) note(`>>> HELLO REPLY SEEN: ${printable.slice(0, 300)}`);
});
process.stdin.on("end", () => note("stdin ended"));

// The handshake exactly as pi-tern's launcher sends it: query + DA1 sentinel.
const hello = `\x1b_tsp;q;${JSON.stringify({ q: "hello", v: [1], app: "pi", ver: "1.0.0-probe", features: ["edit", "undo", "send"] })}\x1b\\`;
process.stdout.write(hello);
process.stdout.write("\x1b[c");
note("sent hello + DA1");

// Also try a bare DA1 alone later, in case Tern keys on that first.
setTimeout(() => {
	process.stdout.write("\x1b[c");
	note("sent a second DA1");
}, 1200);

setTimeout(() => {
	note(`total bytes read from stdin: ${bytes}`);
	note("done");
	process.exit(0);
}, hold * 1000);
