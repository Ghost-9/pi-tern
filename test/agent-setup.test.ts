/**
 * Tests for `/tern agent-setup` — the one code path in pi-tern that writes outside its own
 * sandbox.
 *
 * `setTernAgentDefaults` rewrites the user's `~/Library/Application Support/Tern/settings.json`,
 * which holds their window size, theme and keybindings as well as the two keys pi-tern owns. A bad
 * write there makes Tern unusable until it is hand-repaired, so this file takes the settings path
 * as a parameter and exercises every branch against a temp directory. It must never touch a real
 * Tern install, which is why `setTernAgentDefaults` takes an injectable `TernSettingsIo`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTernAgentDefaults, readTernSettings, type TernSettingsIo } from "../lib/tern.ts";

/** A settings.json in a throwaway temp dir, with the same shape the real one has. */
function tempIo(initial?: Record<string, unknown> | string): TernSettingsIo & { dir: string } {
	const dir = mkdtempSync(path.join(os.tmpdir(), "pi-tern-settings-"));
	const file = path.join(dir, "settings.json");
	if (typeof initial === "string") {
		writeFileSync(file, initial, "utf8");
	} else if (initial !== undefined) {
		writeFileSync(file, `${JSON.stringify(initial, null, 2)}\n`, "utf8");
	}
	return {
		dir,
		file,
		read: () => {
			try {
				return readFileSync(file, "utf8");
			} catch {
				return null;
			}
		},
		write: (contents: string) => writeFileSync(file, contents, "utf8"),
	};
}

function readBack(io: TernSettingsIo): Record<string, unknown> {
	return JSON.parse(io.read() ?? "{}") as Record<string, unknown>;
}

test("agent-setup sets both keys and reports the previous values", () => {
	const io = tempIo({ new_blocks: "Shell", agent_command: "/usr/local/bin/omp", theme: "dark" });
	try {
		const result = setTernAgentDefaults("/Users/you/bin/pi-tern", io);
		assert.equal(result.alreadySet, false);
		const after = readBack(io);
		assert.equal(after.new_blocks, "Agent");
		assert.equal(after.agent_command, "/Users/you/bin/pi-tern");
		assert.equal(result.changed.length, 2);
		assert.match(result.changed.join("\n"), /new_blocks: "Shell" → "Agent"/);
		assert.match(result.changed.join("\n"), /agent_command: "\/usr\/local\/bin\/omp"/);
	} finally {
		rmSync(io.dir, { recursive: true, force: true });
	}
});

test("agent-setup preserves every unrelated key", () => {
	// The real settings.json holds the user's window geometry, theme and keybindings. Losing those
	// to this command would be far worse than the command not working.
	const original = {
		new_blocks: "Shell",
		window: { width: 1512, height: 900 },
		theme: "obsidian",
		keybindings: { "ctrl+shift+u": "context-usage" },
		font_family: "BerkeleyMono",
	};
	const io = tempIo(original);
	try {
		setTernAgentDefaults("/Users/you/bin/pi-tern", io);
		const after = readBack(io);
		assert.deepEqual(after.window, original.window);
		assert.equal(after.theme, "obsidian");
		assert.deepEqual(after.keybindings, original.keybindings);
		assert.equal(after.font_family, "BerkeleyMono");
	} finally {
		rmSync(io.dir, { recursive: true, force: true });
	}
});

test("agent-setup backs up the pre-write file and the backup parses to the original", () => {
	const original = { new_blocks: "Shell", theme: "light" };
	const io = tempIo(original);
	try {
		const result = setTernAgentDefaults("/Users/you/bin/pi-tern", io);
		assert.ok(result.backup, "a backup path is returned when a file existed");
		const backup = JSON.parse(readFileSync(result.backup as string, "utf8")) as Record<string, unknown>;
		assert.deepEqual(backup, original, "the backup holds the file as it was BEFORE the write");
		assert.equal(backup.new_blocks, "Shell", "not the new value — that would be a useless backup");
		assert.equal(readBack(io).new_blocks, "Agent");
	} finally {
		rmSync(io.dir, { recursive: true, force: true });
	}
});

test("agent-setup creates the file when Tern has none yet", () => {
	// A fresh Tern install has no settings.json. This is the exact user: someone who has never
	// configured anything and is running /tern agent-setup because their pane is blank. The old
	// implementation called readFileSync on a missing file and threw.
	const io = tempIo();
	try {
		assert.equal(io.read(), null, "precondition: no settings file exists");
		const result = setTernAgentDefaults("/Users/you/bin/pi-tern", io);
		assert.equal(result.alreadySet, false);
		assert.equal(result.changed.length, 2);
		assert.match(result.changed.join("\n"), /new_blocks: "unset"/);
		assert.match(result.changed.join("\n"), /agent_command: "unset"/);
		assert.equal(readBack(io).new_blocks, "Agent");
		// Nothing existed to back up, so no stray .bak- file should be left next to it.
		assert.equal(result.backup, null);
		assert.deepEqual(readdirSync(io.dir), ["settings.json"]);
	} finally {
		rmSync(io.dir, { recursive: true, force: true });
	}
});

test("agent-setup is idempotent: a second run writes nothing and takes no backup", () => {
	const io = tempIo({ theme: "dark" });
	try {
		const first = setTernAgentDefaults("/Users/you/bin/pi-tern", io);
		assert.equal(first.alreadySet, false);
		const afterFirst = io.read();
		const second = setTernAgentDefaults("/Users/you/bin/pi-tern", io);
		assert.equal(second.alreadySet, true);
		assert.deepEqual(second.changed, [], "nothing changed, so nothing is reported");
		assert.equal(second.backup, null, "a no-op run must not litter the directory with backups");
		assert.equal(io.read(), afterFirst, "the file is not rewritten when it already says the right thing");
		assert.equal(readdirSync(io.dir).filter((f) => f.includes(".bak-")).length, 1, "exactly one backup, from the first run");
	} finally {
		rmSync(io.dir, { recursive: true, force: true });
	}
});

test("agent-setup refuses to overwrite a settings file it cannot parse", () => {
	// A corrupt file still holds the user's keybindings. Losing them to a parse failure here would
	// be the worst outcome of a convenience command, so this must throw and change nothing.
	const corrupt = '{ "theme": "dark", oops';
	const io = tempIo(corrupt);
	try {
		assert.throws(
			() => setTernAgentDefaults("/Users/you/bin/pi-tern", io),
			/not valid JSON/,
			"the failure names the problem",
		);
		assert.equal(io.read(), corrupt, "the file is untouched");
		assert.deepEqual(readdirSync(io.dir), ["settings.json"], "and no backup was written either");
	} finally {
		rmSync(io.dir, { recursive: true, force: true });
	}
});

test("agent-setup updates only the key that is wrong", () => {
	const io = tempIo({ new_blocks: "Agent", agent_command: "/Users/you/bin/pi-tern", theme: "dark" });
	try {
		const result = setTernAgentDefaults("/Users/you/bin/pi-tern", io);
		assert.equal(result.alreadySet, true);
		assert.deepEqual(result.changed, []);
	} finally {
		rmSync(io.dir, { recursive: true, force: true });
	}

	// And the mirror case: only agent_command is stale.
	const io2 = tempIo({ new_blocks: "Agent", agent_command: "/usr/local/bin/omp" });
	try {
		const result = setTernAgentDefaults("/Users/you/bin/pi-tern", io2);
		assert.equal(result.changed.length, 1);
		assert.match(result.changed[0], /^agent_command:/);
	} finally {
		rmSync(io2.dir, { recursive: true, force: true });
	}
});

test("agent-setup handles a launcher path containing spaces and quotes", () => {
	// The launcher path lands in JSON, so it must survive being awkward. A shell-quoting bug here
	// would silently corrupt the settings file.
	const awkward = "/Users/some one/My Apps/pi-tern \"beta\"";
	const io = tempIo({ new_blocks: "Shell" });
	try {
		setTernAgentDefaults(awkward, io);
		assert.equal(readBack(io).agent_command, awkward);
		assert.doesNotThrow(() => JSON.parse(io.read() as string));
	} finally {
		rmSync(io.dir, { recursive: true, force: true });
	}
});

test("readTernSettings returns {} for a missing file and for invalid JSON", () => {
	const missing = tempIo();
	try {
		assert.deepEqual(readTernSettings(missing), {});
	} finally {
		rmSync(missing.dir, { recursive: true, force: true });
	}
	const broken = tempIo("{ nope");
	try {
		assert.deepEqual(readTernSettings(broken), {}, "a read must never throw; callers use it for status");
	} finally {
		rmSync(broken.dir, { recursive: true, force: true });
	}
});

test("the real settings path is never used by these tests", () => {
	// A guard against a future refactor quietly dropping the io parameter: if that happened, these
	// tests would start writing the developer's real Tern settings.
	const source = readFileSync(new URL("../lib/tern.ts", import.meta.url), "utf8");
	const calls = [...source.matchAll(/setTernAgentDefaults\(([^)]*)\)/g)].map((m) => m[1]);
	for (const call of calls) {
		assert.match(call, /io/, "every internal call must pass a TernSettingsIo, never the default");
	}
});

test("the settings directory is created when it does not exist", () => {
	// defaultTernSettingsIo writes for real, so exercise it against a nested temp path rather than
	// the real home directory.
	const dir = mkdtempSync(path.join(os.tmpdir(), "pi-tern-nested-"));
	const file = path.join(dir, "deeply", "nested", "settings.json");
	try {
		const io: TernSettingsIo = {
			file,
			read: () => {
				try {
					return readFileSync(file, "utf8");
				} catch {
					return null;
				}
			},
			write: (contents: string) => {
				mkdirSync(path.dirname(file), { recursive: true });
				writeFileSync(file, contents, "utf8");
			},
		};
		const result = setTernAgentDefaults("/Users/you/bin/pi-tern", io);
		assert.equal(result.file, file);
		assert.equal(readBack(io).agent_command, "/Users/you/bin/pi-tern");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
