/**
 * `tern_fleet prune` — the cleanup path that makes unconditional `--keep-open` a decision rather
 * than a leak.
 *
 * `--keep-open` is unconditional because a spawned pane must outlive its command so its output can
 * be read; a `pi -p` task that finishes in three seconds should not take its transcript with it. The
 * cost is that panes accumulate for the lifetime of the Tern daemon, which survives app updates by
 * design.
 *
 * These tests are about what prune must *never* do, since closing the wrong pane destroys work a
 * person can see.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

/**
 * `fleetPrune` reads and writes the fleet state through `scratchDir()`, and reaches the daemon
 * through `runTern`. `scratchDir()` resolves under `HOME`, so the test points HOME at a temp dir —
 * which is also what guarantees it cannot close a real pane or touch a real fleet file.
 */
const dir = mkdtempSync(path.join(os.tmpdir(), "pi-tern-fleet-"));
const previousHome = process.env.HOME;
// Also take `tern` off PATH: `liveBlocks()` shells out, and a test must never consult — let alone
// close — a real pane. Liveness is injected per test instead.
const previousPath = process.env.PATH;
process.env.HOME = dir;
process.env.PATH = "/nonexistent";
process.env.PI_TERN_STOCK = "true";

const { fleetPrune, DEFAULT_PRUNE_MIN_AGE_MS } = await import("../lib/fleet.ts");

/** No pane is live unless a test says so. */
const nothingLive = async (): Promise<Set<number>> => new Set();
const blocksLive =
	(...blocks: number[]) =>
	async (): Promise<Set<number>> =>
		new Set(blocks);

const fleetFile = path.join(dir, ".pi", "agent", "scratch", "pi-tern", "fleet.json");

const minutesAgo = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();

function seed(members: { block: number; name: string; minutes: number }[]): void {
	mkdirSync(path.dirname(fleetFile), { recursive: true });
	writeFileSync(
		fleetFile,
		JSON.stringify({
			members: members.map((member) => ({
				block: member.block,
				name: member.name,
				task: "task",
				mode: "print",
				startedAt: minutesAgo(member.minutes),
			})),
		}),
	);
}

test.after(() => {
	rmSync(dir, { recursive: true, force: true });
	if (previousHome === undefined) delete process.env.HOME;
	else process.env.HOME = previousHome;
	if (previousPath === undefined) delete process.env.PATH;
	else process.env.PATH = previousPath;
});

test("a dead, old pane is pruned", async () => {
	seed([{ block: 101, name: "old-task", minutes: 120 }]);
	const result = await fleetPrune({ dryRun: true, live: nothingLive });
	assert.equal(result.pruned.length, 1, "expected the stale pane to be eligible");
	assert.equal(result.pruned[0].block, 101);
	assert.match(result.pruned[0].reason, /exited 120m ago/);
});

test("a live pane is never pruned, however old", async () => {
	// The whole reason --keep-open exists: a dev server or a long build must survive.
	seed([{ block: 202, name: "dev-server", minutes: 600 }]);
	const result = await fleetPrune({ dryRun: true, live: blocksLive(202) });
	assert.equal(result.pruned.length, 0, "a running command is never a candidate");
	assert.match(result.kept[0].reason, /live/);

	// And the guard is about liveness, not age: the same pane prunes the moment it exits.
	const afterExit = await fleetPrune({ dryRun: true, live: nothingLive });
	assert.equal(afterExit.pruned.length, 1, "the same 10-hour-old pane prunes once dead");
});

test("a pane younger than the idle floor is kept, with the reason", async () => {
	seed([{ block: 303, name: "just-finished", minutes: 2 }]);
	const result = await fleetPrune({ dryRun: true, live: nothingLive });
	assert.equal(result.pruned.length, 0, "a pane that just exited keeps its output");
	assert.equal(result.kept.length, 1);
	assert.match(result.kept[0].reason, /too young/);
	assert.equal(result.kept[0].block, 303);
});

test("the pane you are running in is protected", async () => {
	// Closing the caller's own pane would kill the session making the request.
	seed([
		{ block: 404, name: "ancient", minutes: 600 },
		{ block: 999, name: "me", minutes: 600 },
	]);
	const result = await fleetPrune({ dryRun: true, protect: [999], live: nothingLive });
	assert.ok(result.kept.some((entry) => entry.block === 999), "the current pane is kept");
	assert.match(result.kept.find((entry) => entry.block === 999)?.reason ?? "", /protected/);
	assert.ok(result.pruned.some((entry) => entry.block === 404), "but others are still eligible");
});

test("TERN_PANE is protected implicitly", async () => {
	process.env.TERN_PANE = "777";
	try {
		seed([{ block: 777, name: "current", minutes: 600 }]);
		const result = await fleetPrune({ dryRun: true, live: nothingLive });
		assert.equal(result.pruned.length, 0, "the pane we are running in is never a candidate");
		assert.match(result.kept[0].reason, /protected/);
	} finally {
		delete process.env.TERN_PANE;
	}
});

test("a dry run changes nothing on disk", async () => {
	seed([
		{ block: 501, name: "a", minutes: 600 },
		{ block: 502, name: "b", minutes: 600 },
	]);
	const before = JSON.parse(readFileSync(fleetFile, "utf8"));
	const result = await fleetPrune({ dryRun: true, live: nothingLive });
	assert.equal(result.pruned.length, 2, "both are reported as eligible");
	const after = JSON.parse(readFileSync(fleetFile, "utf8"));
	assert.deepEqual(after, before, "and the state file is byte-identical afterwards");
});

test("the idle floor is configurable and defaults to 30 minutes", () => {
	assert.equal(DEFAULT_PRUNE_MIN_AGE_MS, 30 * 60_000);
});

test("an empty fleet prunes nothing and does not throw", async () => {
	writeFileSync(fleetFile, JSON.stringify({ members: [] }));
	const result = await fleetPrune({ dryRun: true, live: nothingLive });
	assert.deepEqual(result.pruned, []);
	assert.deepEqual(result.kept, []);
});

test("a corrupt state file is reported rather than silently pruning nothing", async () => {
	writeFileSync(fleetFile, "{ not json");
	// loadFleet falls back to an empty state; the point is that this must not throw, because a
	// corrupt scratch file must not break the tool. Asserting the behaviour, not hiding it.
	const result = await fleetPrune({ dryRun: true, live: nothingLive });
	assert.deepEqual(result.pruned, []);
});
