/**
 * The published package must be self-consistent.
 *
 * Found by actually installing and using it: `npm pack pi-tern@1.1.8` produced a tarball that was
 * missing `lib/handshake.mjs`, `lib/toolresults.ts`, `lib/tools-plugin.ts`, `scripts/render-proof.mjs`
 * and `scripts/check-luau-source.mjs`, and whose `test` script named eight files rather than nine.
 * Nothing in CI noticed, because CI checks out the repository rather than the tarball — so the
 * package a user installs is not the package the tests ran against.
 *
 * That is the same failure as the v1.1.0-tagged run publishing v1.1.8: the artifact and the source
 * drifted apart, and only someone looking at the artifact would notice.
 *
 * These assertions are cheap and run in CI on every build. The end-to-end check - `npm pack`, unpack,
 * run the shipped gate - is in `scripts/check-package.mjs`, because it needs a real install.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
	files: string[];
	scripts: Record<string, string>;
};

/** Every path a `files` entry covers. npm's rules are simple enough here to enumerate. */
function shipped(relative: string): boolean {
	return pkg.files.some((entry) => {
		if (entry === relative) return true;
		if (entry.endsWith("/")) return relative.startsWith(entry);
		// A bare directory name covers everything beneath it.
		if (!entry.includes(".") && !entry.includes("*")) return relative.startsWith(`${entry}/`);
		return false;
	});
}

test("the shipped scripts can only reference shipped files", () => {
	// `scripts/gate.sh` and `npm test` reference paths by name. Anything they name that `files`
	// excludes is a broken command in the published package.
	const referenced = new Set<string>();
	for (const file of ["test/protocol.test.ts", "lib/bridge.ts"]) referenced.add(file);
	// Pull every `test/*.ts` and `lib/*.ts` path out of the scripts themselves.
	const scriptsDir = path.join(root, "scripts");
	for (const name of ["gate.sh"]) {
		const source = readFileSync(path.join(scriptsDir, name), "utf8");
		for (const match of source.matchAll(/\b(test|lib|scripts|native)\/[A-Za-z0-9._-]+\.[a-z]+/g)) {
			referenced.add(match[0]);
		}
	}
	for (const command of Object.values(pkg.scripts)) {
		for (const match of command.matchAll(/\b(test|lib|scripts|native|spikes|examples)\/[A-Za-z0-9._-]+\.[a-z]+/g)) {
			referenced.add(match[0]);
		}
	}

	const missing = [...referenced].filter((relative) => !shipped(relative));
	assert.deepEqual(
		missing,
		[],
		`these are referenced by a shipped script but excluded from package.json "files":\n  ${missing.join("\n  ")}\n` +
			"Either ship them or stop referencing them. A user who installs the tarball cannot run a command that names a file they do not have.",
	);
});

test("the test suite the package advertises is itself shipped", () => {
	// `npm test` is the single definition of the suite. Shipping a script that names ten files and
	// zero of them is how the 1.1.8 tarball shipped a `test` script it could not run.
	const named = [...pkg.scripts.test.matchAll(/\btest\/[A-Za-z0-9._-]+\.ts/g)].map((m) => m[0]);
	assert.ok(named.length >= 8, `expected the suite to name its files, found ${named.length}`);
	for (const file of named) {
		assert.ok(shipped(file), `${file} is named by "npm test" but not shipped`);
		assert.ok(existsSync(path.join(root, file)), `${file} is named by "npm test" but does not exist`);
	}
});

test("every lib module is reachable from what ships", () => {
	// A module under lib/ that nothing imports is dead weight; one that is imported but not shipped
	// is a crash at runtime for anyone installing from npm.
	const shippedLib = shipped("lib/index.ts");
	assert.ok(shippedLib, "lib/ must be shipped: index.ts imports from it");
	for (const file of ["lib/handshake.mjs", "lib/bridge.ts", "lib/version.ts", "lib/toolresults.ts"]) {
		// handshake.mjs lives in native/ (the launcher's own directory); assert the right place.
		const actual = file === "lib/handshake.mjs" ? "native/handshake.mjs" : file;
		assert.ok(existsSync(path.join(root, actual)), `${actual} does not exist`);
		assert.ok(shipped(actual), `${actual} exists but is not shipped`);
	}
});

test("the manifest and the launcher cannot drift apart again", () => {
	// The v1.1.0-tagged run published 1.1.8 because the tag and package.json disagreed. CI runs on
	// a tag, so this is the last place that can be caught before npm.
	//
	// The workflow is not shipped, so when the suite runs from the packed tarball there is nothing
	// here to check. That is not a silent pass: CI always runs this suite against the repository,
	// where the file exists, and `scripts/check-package.mjs` separately proves the tarball's own
	// contents. Skipping is the honest option; failing would make the shipped suite unrunnable, and
	// passing silently would claim a check that did not run.
	const workflow = path.join(root, ".github", "workflows", "release.yml");
	if (!existsSync(workflow)) {
		assert.ok(true, "no .github in this tree (running from the packed tarball); CI runs this against the repo");
		return;
	}
	const source = readFileSync(workflow, "utf8");
	assert.ok(
		source.includes("does not match package.json"),
		"release.yml must fail when the tag disagrees with package.json",
	);
	assert.ok(
		/if: startsWith\(github\.ref_name, 'v'\)/.test(source),
		"publish and release must be gated on a version tag, so a dispatch from a branch cannot release",
	);
});
