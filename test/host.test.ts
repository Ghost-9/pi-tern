/**
 * Which agent a spawned pane runs.
 *
 * Every agent-spawning path used to hard-code `pi`. On a host installed as **pi-bolt** — same
 * package, same version, different executable — that opens a pane running `pi: command not found`
 * while the rest of pi-tern reports itself healthy. On this machine `pi` and `pi-bolt` are the same
 * binary, which is precisely why the name has to be resolved rather than assumed: the test cannot
 * discover the bug by looking at the installed host.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENT_BINARIES, resolveAgentCommand } from "../lib/host.ts";

const pathDirs = ["/usr/bin", "/opt/homebrew/bin"];

test("stock pi is preferred when both hosts are installed", () => {
	const resolution = resolveAgentCommand({
		env: { PATH: pathDirs.join(":") } as NodeJS.ProcessEnv,
		pathDirs,
		exists: () => true,
	});
	assert.equal(resolution.command, "pi");
	assert.equal(resolution.source, "path");
});

test("a pi-bolt-only host resolves to pi-bolt instead of failing to find pi", () => {
	const resolution = resolveAgentCommand({
		env: { PATH: pathDirs.join(":") } as NodeJS.ProcessEnv,
		pathDirs,
		exists: (candidate) => candidate.endsWith("pi-bolt"),
	});
	assert.equal(resolution.command, "pi-bolt");
	assert.equal(resolution.source, "path");
	assert.deepEqual(resolution.looked, ["pi", "pi-bolt"], "what was looked for is reported, so a miss is diagnosable");
});

test("an explicit agent wins over everything, even a path", () => {
	const resolution = resolveAgentCommand({
		env: { PATH: "/usr/bin", PI_TERN_AGENT: "/opt/agents/omp", PI_TERN_LAUNCHER: "/usr/local/bin/pi-tern" } as NodeJS.ProcessEnv,
		pathDirs: ["/usr/bin"],
		exists: () => true,
	});
	assert.equal(resolution.command, "/opt/agents/omp");
	assert.equal(resolution.source, "env");
});

test("a session started through the pi-tern launcher spawns the same agent", () => {
	const resolution = resolveAgentCommand({
		env: { PATH: "/usr/bin", PI_TERN_LAUNCHER: "/Users/x/bin/pi-tern" } as NodeJS.ProcessEnv,
		pathDirs: ["/usr/bin"],
		exists: () => false,
	});
	assert.equal(resolution.command, "/Users/x/bin/pi-tern");
	assert.equal(resolution.source, "launcher");
});

test("with nothing installed the historical default is kept, so the shell reports the miss", () => {
	const resolution = resolveAgentCommand({ env: { PATH: "" } as NodeJS.ProcessEnv, pathDirs: [], exists: () => false });
	assert.equal(resolution.command, AGENT_BINARIES[0]);
	assert.equal(resolution.source, "default");
});

test("an empty PATH entry is skipped rather than resolving to a relative path", () => {
	// `path.join("", "pi")` is `pi`, which would have been reported as a found absolute binary.
	const resolution = resolveAgentCommand({
		env: { PATH: ":/usr/bin" } as NodeJS.ProcessEnv,
		pathDirs: ["", "/usr/bin"],
		exists: (candidate) => candidate === "/usr/bin/pi-bolt",
	});
	assert.equal(resolution.command, "pi-bolt");
});
