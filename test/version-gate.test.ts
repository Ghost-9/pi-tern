/**
 * Version negotiation between pi-tern and the Tern CLI.
 *
 * There was none before 1.2: every call assumed the verb existed. On a build without it, `tern
 * whoami` is not an error message — the CLI treats an unknown first argument as a directory to
 * open, so a missing verb reads as `whoami: No such file or directory` and looks like a broken
 * install. Parsing `tern --version` and naming the version a verb needs is the difference between
 * "your Tern is too old" and a bug report about the wrong thing.
 *
 * `tern --version` prints `0.9.8 (f21d9a3)`; the parens are the build commit, not part of semver.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	cliVerbSupport,
	parseTernVersion,
	readTernEnv,
	sessionVerbSupport,
	SESSION_VERBS_SINCE,
	ternConfigDir,
	ternSettingsPath,
	versionAtLeast,
} from "../lib/tern.ts";

test("a real `tern --version` line parses, commit included", () => {
	const parsed = parseTernVersion("0.9.8 (f21d9a3)");
	assert.ok(parsed);
	assert.equal(parsed.version, "0.9.8");
	assert.deepEqual([parsed.major, parsed.minor, parsed.patch], [0, 9, 8]);
	assert.equal(parsed.commit, "f21d9a3");
	assert.equal(parsed.raw, "0.9.8 (f21d9a3)");
});

test("the shapes an older or wrapped CLI prints all parse", () => {
	for (const [input, expected] of [
		["tern 0.5.2 (21a6de4)", "0.5.2"],
		["0.4.5", "0.4.5"],
		["v0.9.8", "0.9.8"],
		["0.9.8\nsomething else", "0.9.8"],
		["  0.10.0 (abc1234)  ", "0.10.0"],
		["2.0.0-rc.1", "2.0.0"],
	] as const) {
		assert.equal(parseTernVersion(input)?.version, expected, input);
	}
});

test("anything that is not a version is null, not a guess", () => {
	for (const input of ["", "   ", "not installed", "tern", null, undefined]) {
		assert.equal(parseTernVersion(input), null, JSON.stringify(input));
	}
});

test("version comparison is numeric per component, not lexicographic", () => {
	assert.equal(versionAtLeast(parseTernVersion("0.9.8"), "0.9.0"), true);
	assert.equal(versionAtLeast(parseTernVersion("0.10.0"), "0.9.0"), true, "0.10 is newer than 0.9");
	assert.equal(versionAtLeast(parseTernVersion("0.5.2"), "0.9.0"), false);
	assert.equal(versionAtLeast(parseTernVersion("1.0.0"), "0.9.9"), true);
	assert.equal(versionAtLeast(parseTernVersion("0.9.8"), "0.9.8"), true);
	assert.equal(versionAtLeast(parseTernVersion("0.9.7"), "0.9.8"), false);
	assert.equal(versionAtLeast(null, "0.9.0"), false, "no version is not evidence of support");
	assert.equal(versionAtLeast(parseTernVersion("nonsense"), "0.9.0"), false);
});

test("a 0.5.x Tern is told which version the verb needs, and nothing else is disabled", () => {
	const support = sessionVerbSupport({ cli: true, release: parseTernVersion("0.5.2 (21a6de4)") }, "whoami");
	assert.equal(support.supported, false);
	assert.match(String(support.reason), /needs Tern 0\.9\.0 or newer/);
	assert.match(String(support.reason), /this is 0\.5\.2/, "the reason names the build it found");
	assert.match(String(support.reason), /Everything else still works/, "and says the rest is unaffected");
});

test("0.9.8 supports every session verb", () => {
	for (const verb of ["whoami", "process", "rename", "move", "pip", "dock", "keep-open"] as const) {
		const support = sessionVerbSupport({ cli: true, release: parseTernVersion("0.9.8 (f21d9a3)") }, verb);
		assert.equal(support.supported, true, verb);
		assert.equal(support.version, "0.9.8");
	}
	assert.equal(SESSION_VERBS_SINCE, "0.9.0", "the boundary the reasons quote");
});

test("no CLI at all is reported as no CLI, not as an old version", () => {
	const missing = sessionVerbSupport({ cli: false }, "process");
	assert.equal(missing.supported, false);
	assert.match(String(missing.reason), /did not answer on PATH/);

	const unversioned = sessionVerbSupport({ cli: true }, "pip");
	assert.equal(unversioned.supported, false);
	assert.match(String(unversioned.reason), /did not report a version/);
	assert.equal(cliVerbSupport(null, "plugin types").supported, false);
});

test("PI_TERN_FORCE=1 can bypass the version gate, for a fork that backports a verb", () => {
	const previous = process.env.PI_TERN_FORCE;
	process.env.PI_TERN_FORCE = "1";
	try {
		assert.equal(sessionVerbSupport({ cli: false }, "whoami").supported, true);
		assert.equal(cliVerbSupport({ cli: false }, "plugin types").supported, true);
	} finally {
		if (previous === undefined) delete process.env.PI_TERN_FORCE;
		else process.env.PI_TERN_FORCE = previous;
	}
});

test("TERN_CONFIG_DIR moves Tern's settings file, so agent-setup edits the file Tern reads", () => {
	// 0.9.x exports TERN_CONFIG_DIR. Editing a hard-coded Application Support path while Tern reads
	// another directory is a change that reports success and does nothing.
	assert.equal(ternConfigDir({ TERN_CONFIG_DIR: "/tmp/tern-cfg" }), "/tmp/tern-cfg");
	assert.equal(ternSettingsPath({ TERN_CONFIG_DIR: "/tmp/tern-cfg" }), "/tmp/tern-cfg/settings.json");
	assert.match(ternSettingsPath({}), /Application Support\/Tern\/settings\.json$/);
});

test("the 0.9 pane environment is read additively and older panes still work", () => {
	const modern = readTernEnv({
		TERM_PROGRAM: "tern",
		TERM_PROGRAM_VERSION: "0.9.8",
		TERN_PANE: "3",
		TERN_PANE_SOCKET: "/tmp/daemon.sock",
		TERN_CONFIG_DIR: "/tmp/cfg",
		TERN_DAEMON_SOCKET: "/tmp/daemon.sock",
		TERN_IDENTITY: '{"hops":[]}',
		TERN_EXE: "/opt/homebrew/bin/tern",
	} as NodeJS.ProcessEnv);
	assert.deepEqual(modern, {
		inTern: true,
		version: "0.9.8",
		paneId: "3",
		paneSocket: "/tmp/daemon.sock",
		windowSocket: undefined,
		windowKey: undefined,
		configDir: "/tmp/cfg",
		daemonSocket: "/tmp/daemon.sock",
		identity: '{"hops":[]}',
		exe: "/opt/homebrew/bin/tern",
	});

	// A 0.5-era pane: no TERN_CONFIG_DIR, no TERN_IDENTITY. Nothing may require them.
	const legacy = readTernEnv({
		TERM_PROGRAM: "tern",
		TERM_PROGRAM_VERSION: "0.5.1",
		TERN_PANE: "7",
		TERN_PANE_SOCKET: "/tmp/pane-7.sock",
	} as NodeJS.ProcessEnv);
	assert.equal(legacy.inTern, true);
	assert.equal(legacy.configDir, undefined);
	assert.equal(legacy.identity, undefined);
	assert.equal(legacy.daemonSocket, undefined);
});
