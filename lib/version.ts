/**
 * The one place this version is written down.
 *
 * The 1.1.3 P0 was `lib/mailbox.ts` holding a hand-maintained `EXPECTED_PLUGIN_VERSION` that fell
 * behind the plugin it was checking, so `awaitResponse` rejected a correct reply and every
 * data-plane call failed on a fresh window — in a version already pushed. Three copies of the
 * number existed (the plugin manifest, the Luau window entry, and the package), and a test caught
 * it only after the fact.
 *
 * So it is derived. Bump `package.json` and everything follows; `test/version.test.ts` then checks
 * the manifest, the Luau and the package still agree.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// this file is <root>/lib/version.ts, so the package root is one level up from here.
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = path.join(packageRoot, "package.json");

/** This package's version, read from package.json. The single source of truth. */
export const PLUGIN_VERSION: string = (() => {
	try {
		const parsed = JSON.parse(readFileSync(packageJson, "utf8")) as { version?: unknown };
		if (typeof parsed.version !== "string" || parsed.version.length === 0) {
			throw new Error("package.json has no string `version`");
		}
		return parsed.version;
	} catch (error) {
		// Throwing here is correct: a silent fallback is exactly how the version drifted before.
		throw new Error(
			`could not read the version from ${packageJson}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
})();
