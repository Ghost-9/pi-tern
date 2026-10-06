/**
 * Lint the generated Luau before it ever reaches Tern.
 *
 * Why this file exists: the plugin's Lua lives inside a TypeScript template literal, so a
 * single `\n` written where `\\n` was meant silently becomes a real newline inside a Lua
 * string, and Tern only reports it much later as
 *   `plugin window entry failed to load … syntax error: window.luau:44: Malformed string`
 * — in a log, on the next window start, with the plugin still listed as `ready`.
 *
 * That happened three times while building 1.1.2, so it is now a test rather than a habit.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BRIDGE_PLUGIN_TOML, BRIDGE_WINDOW_LUAU } from "../lib/bridge-plugin.ts";
import { EXPECTED_PLUGIN_VERSION } from "../lib/mailbox.ts";

/** Count unescaped double quotes outside a comment. */
function quoteBalance(line: string): number {
	const code = line.includes("--") ? line.slice(0, line.indexOf("--")) : line;
	let count = 0;
	let i = 0;
	while (i < code.length) {
		if (code[i] === "\\") {
			i += 2;
			continue;
		}
		if (code[i] === '"') count += 1;
		i += 1;
	}
	return count;
}

test("no Lua string literal spans a line break", () => {
	const offenders: string[] = [];
	BRIDGE_WINDOW_LUAU.split("\n").forEach((line, index) => {
		if (quoteBalance(line) % 2 === 1) offenders.push(`${index + 1}: ${line.trim().slice(0, 80)}`);
	});
	assert.deepEqual(offenders, [], `unterminated Lua string(s):\n${offenders.join("\n")}`);
});

test("the generated Lua contains no raw control characters", () => {
	// A TAB inside a Lua string is legal, but a newline or carriage return never is.
	const bad = BRIDGE_WINDOW_LUAU.split("\n").filter((line) => /"/.test(line) && /\r/.test(line));
	assert.deepEqual(bad, []);
	assert.ok(!/\r/.test(BRIDGE_WINDOW_LUAU), "no CR");
});

test("every Lua escape is one Lua understands", () => {
	// Lua's escapes: a b f n r t v \ " ' and \x \d \z \u. A backtick is NOT an escape, so it must
	// appear unescaped — which means no backslash before it may survive into the Lua source.
	const bad = [...BRIDGE_WINDOW_LUAU.matchAll(/\\\\([^abfnrtv\\'"0-9xzul])/g)].map((match) => match[0]);
	assert.deepEqual(bad, [], `invalid Lua escapes: ${bad.join(" ")}`);
	assert.ok(!BRIDGE_WINDOW_LUAU.includes("\\`"), "backticks must be literal in Lua");
});

test("the plugin manifest version matches the Lua and the package", () => {
	const tomlVersion = BRIDGE_PLUGIN_TOML.match(/version = "([^"]+)"/)?.[1];
	const luaVersion = BRIDGE_WINDOW_LUAU.match(/PLUGIN_VERSION = "([^"]+)"/)?.[1];
	assert.ok(tomlVersion, "manifest declares a version");
	assert.equal(luaVersion, tomlVersion, "PLUGIN_VERSION matches the manifest");
});

test("the mailbox expects exactly the plugin version this extension ships", () => {
	// These were two hand-maintained constants and they drifted: the plugin moved to 1.1.2 while
	// the guard still expected 0.9.0, so every data-plane call rejected a correct reply. The
	// constant is now derived, and this asserts the derivation still holds.
	const tomlVersion = BRIDGE_PLUGIN_TOML.match(/version = "([^"]+)"/)?.[1];
	assert.equal(EXPECTED_PLUGIN_VERSION, tomlVersion);
	assert.notEqual(EXPECTED_PLUGIN_VERSION, "0.0.0", "the version must parse from the manifest");
	const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
	assert.equal(tomlVersion, pkg.version, "the plugin manifest tracks the package version");
});

test("the window half only uses APIs it is allowed to use", () => {
	// tern.block.define and tern.lens.define are HOST-only; a window entry calling them fails.
	assert.ok(!/\btern\.block\.define\b/.test(BRIDGE_WINDOW_LUAU), "no host-only block.define");
	assert.ok(!/\btern\.lens\.define\b/.test(BRIDGE_WINDOW_LUAU), "no host-only lens.define");
	// The mailbox must survive being reloaded; the timer is armed by the plugin itself.
	assert.ok(BRIDGE_WINDOW_LUAU.includes("tern.timer"), "the mailbox timer is armed");
});

test("the mailbox op list has no truncated or duplicated branches", () => {
	// A stray paren or a lost `then` is invisible to a quote-balance check but fatal to Lua, and Tern
	// only reports it on the next window start. One such slip reached the tree while adding pane.kind.
	const ops = [...BRIDGE_WINDOW_LUAU.matchAll(/if op == "([a-z.]+)" then/g)].map((m) => m[1]);
	assert.ok(ops.includes("system.ping"), "system.ping is present");
	assert.ok(ops.includes("pane.kind"), "pane.kind is present (the block-kind guard depends on it)");
	assert.equal(new Set(ops).size, ops.length, `duplicate op branches: ${ops.join(", ")}`);
	for (const line of BRIDGE_WINDOW_LUAU.split("\n").filter((l) => l.includes("if op =="))) {
		assert.ok(line.includes(" then"), `Lua if without then: ${line.trim()}`);
		assert.ok(!line.includes("if (op"), `stray paren in Lua if: ${line.trim()}`);
	}
});

test("pane.kind reads the block kind the native fallback depends on", () => {
	assert.ok(BRIDGE_WINDOW_LUAU.includes("cx.session:panes()"), "reads panes from the window API");
	assert.ok(BRIDGE_WINDOW_LUAU.includes("p.kind"), "returns the kind field");
});

test("the dashboard prefers the structured view and falls back to markdown", () => {
	assert.ok(BRIDGE_WINDOW_LUAU.includes("dashboard.json"), "reads the structured panel");
	assert.ok(BRIDGE_WINDOW_LUAU.includes("dashboard.md"), "keeps the markdown fallback");
	assert.ok(BRIDGE_WINDOW_LUAU.includes("tern.ui.bars"), "uses the native chart widget");
	assert.ok(BRIDGE_WINDOW_LUAU.includes("tern.ui.path"), "uses the clickable path span");
	assert.ok(BRIDGE_WINDOW_LUAU.includes("tern.route.link"), "routes file links to the preview");
});
