/**
 * `tern_fleet spawn` and the keep-open policy.
 *
 * A print or command member is a one-shot job: when its program exits the pane should go with it, so
 * nothing accumulates. An interactive member is the opposite, because the pane *is* the session, and
 * `keepOpen: true` asks for the output to outlive the exit.
 *
 * The spawn itself needs a daemon, so what is asserted here is the argv the spawn would run.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const { spawnArgs } = await import("../lib/fleet.ts");

const command = "pi -p \"$(cat /tmp/task.txt)\"";

test("a print member closes its pane when the program exits", () => {
	const args = spawnArgs({ keepOpen: false, command });
	assert.deepEqual(args, ["new", "tab", "--json", "--", "sh", "-lc", command]);
	assert.ok(!args.includes("--keep-open"));
});

test("a command member closes its pane too", () => {
	assert.ok(!spawnArgs({ keepOpen: false, command: "make build" }).includes("--keep-open"));
});

test("keepOpen true keeps the pane so the output can be read afterwards", () => {
	const args = spawnArgs({ keepOpen: true, command });
	assert.deepEqual(args, ["new", "tab", "--json", "--keep-open", "--", "sh", "-lc", command]);
});

test("an interactive member keeps its pane, because the pane is the session", () => {
	// `fleetSpawn` resolves the default as `options.keepOpen ?? mode === "interactive"`, so the
	// interactive case reaches `spawnArgs` with `keepOpen: true`; this is the argv that produces.
	assert.ok(spawnArgs({ keepOpen: true, command: "pi" }).includes("--keep-open"));
});

test("cwd becomes --cwd and the command stays one argv slot", () => {
	const args = spawnArgs({ keepOpen: false, cwd: "/tmp/work tree", command: "echo 'a b'" });
	assert.deepEqual(args, ["new", "tab", "--json", "--cwd", "/tmp/work tree", "--", "sh", "-lc", "echo 'a b'"]);
});
