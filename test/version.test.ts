/**
 * One version, one place.
 *
 * The 1.1.3 P0 was a hand-maintained `EXPECTED_PLUGIN_VERSION` that fell behind the plugin it was
 * checking, so `awaitResponse` rejected correct replies and every data-plane call
 * (`tern_db`, `tern_doc`, `tern_board`, `tern_carly`, `tern_notebook`, `tern_settings`) failed on a
 * fresh window — in a version already pushed. There were three copies of the number to drift apart:
 * the plugin manifest, the Luau window entry, and package.json.
 *
 * They are derived now. This file makes going back to a literal a test failure rather than
 something that has to be caught in production again.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { BRIDGE_PLUGIN_TOML, BRIDGE_WINDOW_LUAU } from "../lib/bridge-plugin.ts";
import { EXPECTED_PLUGIN_VERSION } from "../lib/mailbox.ts";
import { PLUGIN_VERSION } from "../lib/version.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version: string };

test("the plugin version is derived from package.json, not written down twice", () => {
	assert.equal(PLUGIN_VERSION, pkg.version, "lib/version.ts reads package.json");
	assert.notEqual(PLUGIN_VERSION, "0.0.0", "the version must actually parse");
});

test("the manifest, the Luau and the package all agree", () => {
	const tomlVersion = BRIDGE_PLUGIN_TOML.match(/version = "([^"]+)"/)?.[1];
	const luaVersion = BRIDGE_WINDOW_LUAU.match(/local PLUGIN_VERSION = "([^"]+)"/)?.[1];
	assert.equal(tomlVersion, pkg.version, "the plugin manifest tracks the package");
	assert.equal(luaVersion, pkg.version, "the window entry tracks the package");
	assert.equal(EXPECTED_PLUGIN_VERSION, tomlVersion, "the mailbox guard matches the manifest");
});

/**
 * Files where a hand-written copy of this project's version has actually caused a defect, plus
 * the entry point. `lib/mailbox.ts` is the 1.1.3 P0 itself; `lib/bridge-plugin.ts` holds the
 * manifest and the Luau; `index.ts` advertises the version in the TSP hello.
 *
 * Deliberately NOT a whole-tree scan: the probe scripts send `ver: "1.0.0-probe"` and the hello
 * encoder defaults to `"1.0.0-m1"`. Those are protocol sentinels identifying a probe or a
 * milestone build, not a copy of this project's version, and flagging them would train the check
 * to be ignored.
 */
const VERSION_CARRYING = ["index.ts", "lib/bridge-plugin.ts", "lib/mailbox.ts", "scripts/verify.ts"];

test("no file that carries this project's version hard-codes it", () => {
	const offenders: string[] = [];
	for (const relative of VERSION_CARRYING) {
		const source = readFileSync(path.join(root, relative), "utf8");
		for (const match of source.matchAll(/["'`]v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?["'`]/g)) {
			const found = match[0].slice(1, -1);
			// The current version is fine when it is interpolated, and so is the "0.0.0" sentinel
			// that means "the manifest did not parse" — that one is asserted elsewhere.
			if (found === pkg.version || found === `v${pkg.version}` || found === "0.0.0") continue;
			offenders.push(`${relative}: ${found}`);
		}
		// Also reject a bare literal assigned to a version-shaped name, whatever it is called.
		// `${PLUGIN_VERSION}` is the interpolated form and is exactly what we want.
		for (const match of source.matchAll(/(?:EXPECTED_)?PLUGIN_VERSION\s*=\s*(["'`])([^"'`$]*)\1/g)) {
			if (match[2].length === 0) continue;
			offenders.push(`${relative}: PLUGIN_VERSION is assigned the literal "${match[2]}"`);
		}
	}
	assert.deepEqual(
		offenders,
		[],
		`import PLUGIN_VERSION from lib/version.ts instead of writing these down:\n  ${offenders.join("\n  ")}`,
	);
	// Sanity: the detector really does match this shape, or the assertion above is vacuous.
	assert.equal(`x="0.0.1"`.match(/["'`]v?\d+\.\d+\.\d+["'`]/)?.[0], `"0.0.1"`, "detector matches a quoted version");
	assert.equal(`PLUGIN_VERSION = "9.9.9"`.match(/(?:EXPECTED_)?PLUGIN_VERSION\s*=\s*(["'`])([^"'`$]*)\1/)?.[2], "9.9.9", "detector matches an assigned literal");
});
