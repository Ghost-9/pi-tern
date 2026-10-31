#!/usr/bin/env node
/**
 * Check pi-tern's Luau against Tern's plugin API declaration.
 *
 *   node scripts/plugin-api-check.mjs                 check the committed fixture
 *   node scripts/plugin-api-check.mjs --live          ask Tern (`tern plugin types`) and check that
 *   node scripts/plugin-api-check.mjs --write         regenerate the fixture from the installed Tern
 *
 * The fixture (`test/fixtures/tern-api-<version>.json`) is the declared API extracted from a real
 * `tern plugin types` on Tern 0.9.8 (f21d9a3), so the check runs with no Tern installed and still
 * catches the failure that matters: a Luau call to something the declaration does not have.
 *
 * `--write` is the only way the fixture changes, and it prints the version it came from — a
 * regenerated fixture that silently lost a symbol would turn this check into a rubber stamp, so the
 * test also asserts our own symbols are all still present.
 *
 * Exit code 1 when a symbol is missing or nothing was checked.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkAgainst, extractDeclaredApi } from "../lib/luau-api.ts";
import { BRIDGE_WINDOW_LUAU } from "../lib/bridge-plugin.ts";
import { TOOLS_WINDOW_LUAU } from "../lib/tools-plugin.ts";
import { runTern } from "../lib/tern.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = path.join(root, "test", "fixtures", "tern-api-0.9.8.json");
const LUAU = [BRIDGE_WINDOW_LUAU, TOOLS_WINDOW_LUAU];

async function liveTypes() {
	const dir = mkdtempSync(path.join(os.tmpdir(), "pi-tern-types-"));
	try {
		const version = await runTern(["--version"], 5000);
		const written = await runTern(["plugin", "types", dir], 20000);
		if (written.code !== 0) {
			throw new Error(`${(written.stderr || written.stdout).trim() || `tern plugin types exited ${written.code}`}`);
		}
		return { source: readFileSync(path.join(dir, "tern.d.luau"), "utf8"), version: version.stdout.trim() };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const mode = process.argv.includes("--live") ? "live" : process.argv.includes("--write") ? "write" : "fixture";

if (mode === "write") {
	const { source, version } = await liveTypes();
	const api = extractDeclaredApi(source);
	const payload = { ternVersion: version, source: "tern plugin types", api };
	writeFileSync(FIXTURE, `${JSON.stringify(payload, null, 1)}\n`, "utf8");
	console.log(`wrote ${path.relative(root, FIXTURE)} from tern ${version}: ${api.tern.length} tern paths, ${Object.keys(api.externTypes).length} types`);
	process.exit(0);
}

let declared;
let label;
if (mode === "live") {
	const { source, version } = await liveTypes();
	declared = extractDeclaredApi(source);
	label = `live tern plugin types (${version})`;
} else {
	const payload = JSON.parse(readFileSync(FIXTURE, "utf8"));
	declared = payload.api;
	label = `fixture (${payload.ternVersion})`;
}

const result = checkAgainst(declared, LUAU);
console.log(`plugin API check — ${label}`);
console.log(`  declared: ${result.declaredTern} tern paths, ${result.declaredTypes} extern types`);
console.log(`  used by the shipped Luau: ${result.used} symbols`);
if (result.missing.length > 0) {
	console.error(`  MISSING: ${result.missing.join(", ")}`);
	process.exit(1);
}
if (result.used < 40) {
	console.error(`  FAIL: only ${result.used} symbols were read out of the Luau — the extractor found nothing, so this proves nothing`);
	process.exit(1);
}
console.log("  ok: every symbol the Luau uses is declared");
