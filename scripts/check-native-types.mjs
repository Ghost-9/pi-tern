#!/usr/bin/env node
/**
 * Keep `native/native.d.mts` honest.
 *
 * The launcher is plain `.mjs` with no build step, so its types live in a hand-written declaration
 * file. A declaration that names an export the module does not have is worse than no declaration:
 * it type-checks green against an API that is not there. This compares every exported name.
 *
 * Run by scripts/gate.sh (and by CI).
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const nativeDir = path.join(here, "..", "native");

/** Collect the names a module actually exports. */
async function actualExports(file) {
	const mod = await import(path.join(nativeDir, file));
	return new Set(Object.keys(mod));
}

const MODULES = ["backend", "ansi", "layout", "tsp", "handshake"];

// The per-module `.d.mts` files re-export from `native.d.mts`, so the declarations to compare live
// in one place. Read that one file, then check each module against its share of it. Reading the
// shims instead would only ever see `export *` — i.e. zero names — and the check would pass while
// proving nothing, which is the exact failure mode this script exists to prevent.
const SHARED_DECLARATION = "native.d.mts";
const sharedSource = readFileSync(path.join(nativeDir, SHARED_DECLARATION), "utf8");

/** Collect the names a declaration source promises, split by whether they are values or types. */
function declaredExportsFrom(source) {
	const values = new Set();
	const types = new Set();
	// `export declare function foo` / `export function foo` / `export async function foo`
	for (const m of source.matchAll(/export\s+(?:declare\s+)?(?:async\s+)?function\s+(\w+)/g)) values.add(m[1]);
	// `export const foo` / `export declare const foo`
	for (const m of source.matchAll(/export\s+(?:declare\s+)?(?:const|let|var)\s+(\w+)/g)) values.add(m[1]);
	// `export class Foo` / `export declare class Foo`
	for (const m of source.matchAll(/export\s+(?:declare\s+)?class\s+(\w+)/g)) values.add(m[1]);
	// `export interface Foo` / `export type Foo` — erased at runtime, so only checked for drift
	// in the other direction.
	for (const m of source.matchAll(/export\s+(?:declare\s+)?(?:interface|type)\s+(\w+)/g)) types.add(m[1]);
	return { values, types };
}

const shared = declaredExportsFrom(sharedSource);
const allDeclaredValues = shared.values;
const problems = [];
const allActualValues = new Set();
let checked = 0;

for (const mod of MODULES) {
	const declFile = `${mod}.d.mts`;
	if (!readdirSync(nativeDir).includes(declFile)) {
		problems.push(`${declFile}: missing — the .mjs module is outside the typecheck`);
		continue;
	}
	// A shim must re-export, not invent its own names.
	const shim = declaredExportsFrom(readFileSync(path.join(nativeDir, declFile), "utf8"));
	for (const name of shim.values) {
		if (!allDeclaredValues.has(name)) {
			problems.push(`${declFile} declares \`${name}\`, which ${SHARED_DECLARATION} does not`);
		}
	}

	let actual;
	try {
		actual = await actualExports(`${mod}.mjs`);
	} catch (error) {
		problems.push(`${mod}.mjs: could not import (${error.message})`);
		continue;
	}
	if (actual.size === 0) problems.push(`${mod}.mjs exported nothing — the import is probably wrong`);
	for (const name of actual) {
		allActualValues.add(name);
		checked += 1;
		if (!allDeclaredValues.has(name)) {
			problems.push(`${mod}.mjs exports \`${name}\`, which ${SHARED_DECLARATION} does not declare`);
		}
	}
}

// The other direction: a declared value that no module exports is a promise the typecheck will
// keep honouring against an API that is not there. This is the direction that let
// `createNativeSink` type-check green while `nodeOf` did not exist yet.
for (const name of allDeclaredValues) {
	if (!allActualValues.has(name)) {
		problems.push(`${SHARED_DECLARATION} declares value \`${name}\`, which no native/*.mjs module exports`);
	}
}

if (problems.length > 0) {
	console.error("native declaration drift:");
	for (const problem of problems) console.error(`  - ${problem}`);
	process.exit(1);
}
console.log(
	`ok   native declarations match the modules (${checked} real exports, ${allDeclaredValues.size} declared values, ${shared.types.size} types)`,
);
