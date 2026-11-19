/**
 * `tern_fleet spawn bg: true` — the detached member.
 *
 * A detached member holds no pane: its work runs in its own session, its output goes to a log file
 * and its pid to a pid file. So everything that used to be answered by the pane (is it alive? what
 * did it print? stop it) is answered by the pid and the log instead — and prune has to drop the
 * record once that pid is gone, because there is no pane left to close.
 *
 * These tests are about those three substitutes; `fleetSpawn` itself needs a real daemon, so the
 * spawn side is exercised live in `scripts/verify.ts` and the substitution is what is asserted here.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const dir = mkdtempSync(path.join(os.tmpdir(), "pi-tern-fleet-bg-"));
const previousHome = process.env.HOME;
// Never consult a real daemon, and never be tempted to close a real pane.
const previousPath = process.env.PATH;
process.env.HOME = dir;
process.env.PATH = "/nonexistent";
process.env.PI_TERN_STOCK = "true";

const { bgProcessAlive, fleetRead, fleetStatus, fleetPrune, DEFAULT_PRUNE_MIN_AGE_MS } = await import("../lib/fleet.ts");

const nothingLive = async (): Promise<Set<number>> => new Set();
const scratch = path.join(dir, ".pi", "agent", "scratch", "pi-tern");
const fleetFile = path.join(scratch, "fleet.json");

const minutesAgo = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();

/**
 * A pid that is certainly dead: this process spawned a throwaway node and reaped it. Uses
 * `process.execPath` because these tests deliberately run with `PATH` pointing nowhere.
 */
function deadPid(): number {
	const child = spawnSync(process.execPath, ["-e", "0"]);
	assert.equal(child.status, 0, "the probe process must exit cleanly");
	return child.pid ?? 0;
}

function seedBg(members: { block: number; name: string; minutes: number; pid: number }[]): void {
	mkdirSync(scratch, { recursive: true });
	writeFileSync(
		fleetFile,
		JSON.stringify({
			members: members.map((member) => {
				const logFile = path.join(scratch, `fleet-${member.name}.log`);
				writeFileSync(logFile, "line one\nline two\n", "utf8");
				return {
					block: member.block,
					name: member.name,
					task: "task",
					mode: "command",
					bg: true,
					pid: member.pid,
					logFile,
					startedAt: minutesAgo(member.minutes),
				};
			}),
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

test("bgProcessAlive reads a dead pid as dead and a live one as live", () => {
	assert.equal(bgProcessAlive(process.pid), true, "this test process is alive");
	assert.equal(bgProcessAlive(deadPid()), false, "a reaped child is gone");
	assert.equal(bgProcessAlive(0), false, "no pid is not a live pid");
	assert.equal(bgProcessAlive(undefined), false);
});

test("read returns the log, because a detached member has no pane to capture", async () => {
	seedBg([{ block: 501, name: "logged", minutes: 1, pid: process.pid }]);
	const text = await fleetRead(501);
	assert.match(text, /line one/, "the log file is the transcript");
	assert.match(text, /line two/);
});

test("status reads liveness from the pid, not from a pane", async () => {
	seedBg([
		{ block: 601, name: "running", minutes: 5, pid: process.pid },
		{ block: 602, name: "finished", minutes: 5, pid: deadPid() },
	]);
	const status = await fleetStatus({ read: true });
	const running = status.find((member) => member.block === 601);
	const finished = status.find((member) => member.block === 602);
	// The daemon would report both panes gone: a detached member's pane is expected to be gone.
	assert.equal(running?.live, true, "a live detached pid is live");
	assert.equal(finished?.live, false, "an exited detached pid is not");
	assert.match(running?.tail ?? "", /line two/, "list --read still works off the log");
});

test("prune drops the record of an exited detached member and keeps a running one", async () => {
	seedBg([
		{ block: 701, name: "old-finished", minutes: 120, pid: deadPid() },
		{ block: 702, name: "old-running", minutes: 120, pid: process.pid },
		{ block: 703, name: "young-finished", minutes: 1, pid: deadPid() },
	]);
	const dry = await fleetPrune({ dryRun: true, live: nothingLive });
	assert.deepEqual(
		dry.pruned.map((entry) => entry.block),
		[701],
		"only the old, exited detached member is eligible",
	);
	assert.match(dry.kept.find((entry) => entry.block === 702)?.reason ?? "", /detached process is still running/);
	assert.match(dry.kept.find((entry) => entry.block === 703)?.reason ?? "", /too young/);

	const real = await fleetPrune({ live: nothingLive });
	assert.deepEqual(
		real.pruned.map((entry) => entry.block),
		[701],
		"the same member prunes for real once it is eligible",
	);
	const recorded = (JSON.parse(readFileSync(fleetFile, "utf8")) as { members: { block: number }[] }).members;
	assert.ok(!recorded.some((member) => member.block === 701), "the pruned record is gone");
	assert.ok(recorded.some((member) => member.block === 702), "the live one is still tracked");
	assert.ok(recorded.some((member) => member.block === 703), "the young one is still tracked");
});

test("the default idle floor is the pane floor, so a bg prune is not more eager", () => {
	const seedMinutes = Math.round(DEFAULT_PRUNE_MIN_AGE_MS / 60_000);
	assert.equal(seedMinutes, 30, "detached members share the 30m floor");
});
