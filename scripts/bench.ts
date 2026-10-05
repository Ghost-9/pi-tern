/**
 * Reproduce the pi-tern mailbox latency baseline.
 *
 * Run inside a Tern session with the pi-bridge plugin loaded:
 *   node --experimental-strip-types scripts/bench.ts
 *
 * The numbers mirror docs/BENCHMARKING.md; the mailbox poll is the dominant cost.
 */
import { mailbox, mailboxBatch } from "../lib/mailbox.ts";

const stats = (xs: number[]) => {
	const sorted = [...xs].sort((a, b) => a - b);
	return { n: xs.length, min: sorted[0], median: sorted[Math.floor(sorted.length / 2)], max: sorted.at(-1) };
};

const ping: number[] = [];
for (let i = 0; i < 10; i++) ping.push((await mailbox("system.ping", {}, 6000)).ms);
console.log("ping (single op) ms:", JSON.stringify(stats(ping)));

const batch: number[] = [];
for (let i = 0; i < 5; i++) {
	const result = await mailboxBatch([{ op: "system.ping" }, { op: "system.ping" }, { op: "system.ping" }], 10000);
	batch.push(result.ms);
}
console.log("batch (3 ops, one round trip) ms:", JSON.stringify(stats(batch)));
console.log(
	"per-op cost in a batch vs single:",
	(stats(batch).median / 3).toFixed(0),
	"ms vs",
	stats(ping).median,
	"ms",
);
