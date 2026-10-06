#!/usr/bin/env node
/**
 * Source-integrity checks on the generated Luau, done as TEXT rather than by importing it.
 *
 * This has to be a script and not a test. The plugin's Lua lives inside a TypeScript template
 * literal in lib/bridge-plugin.ts, so a bare backtick in the Luau terminates that literal early:
 * the module stops being valid TypeScript and anything importing it — including the test file
 * that would check for this — dies with `ERR_INVALID_TYPESCRIPT_SYNTAX` and an error that points at
 * the parser rather than at the comment that caused it. Verified: injecting one backtick makes the
 * whole test file fail to load with no indication of the real cause.
 *
 * Reading the file as text avoids that entirely, and runs before anything imports the module.
 *
 * The sibling failure is a `\n` written where `\\n` was meant, which becomes a real newline inside
 * a Lua string and which Tern reports only on the next window start, as a log line, while
 * `plugin list` still says `ready`. That one is linted in test/bridge-luau.test.ts, which can run
 * because it does not corrupt the module.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = path.join(root, "lib", "bridge-plugin.ts");
const source = readFileSync(file, "utf8");
const problems = [];

const match = /export const BRIDGE_WINDOW_LUAU = `([\s\S]*?)\n`;\n/.exec(source);
if (!match) {
	console.error(`could not find the BRIDGE_WINDOW_LUAU template literal in ${file}`);
	process.exit(1);
}
const lua = match[1];

// A bare backtick ends the literal. An escaped one (\`) reaches the Lua as a literal backtick
// inside a comment, which is why the existing comments use them and why they are allowed.
const bareBackticks = lua
	.split("\n")
	.map((line, index) => ({ index: index + 1, line }))
	.filter(({ line }) => /(?<!\\)`/.test(line))
	.map(({ index, line }) => `  ${path.relative(root, file)}:${index}: ${line.trim().slice(0, 90)}`);
if (bareBackticks.length > 0) {
	problems.push(
		"a bare backtick in the Luau source terminates the TypeScript template literal:\n" +
			bareBackticks.join("\n") +
			"\n  Escape it as \\` if the comment genuinely needs one.",
	);
}

// A `${` in the Luau would be interpolated by TypeScript, silently substituting JS into Lua.
const interpolations = lua
	.split("\n")
	.map((line, index) => ({ index: index + 1, line }))
	.filter(({ line }) => /\$\{/.test(line) && !line.includes('"${PLUGIN_VERSION}"') && !line.includes('"${PI_TERN'))
	.map(({ index, line }) => `  ${path.relative(root, file)}:${index}: ${line.trim().slice(0, 90)}`);
if (interpolations.length > 0) {
	problems.push(
		"a ${...} in the Luau source is interpolated by TypeScript rather than reaching the plugin:\n" +
			interpolations.join("\n"),
	);
}

// The window entry must not grow a bare tab or CR inside a string; Tern's log is the only place
// either would show up, and only on the next window start.
const controlChars = lua
	.split("\n")
	.map((line, index) => ({ index: index + 1, line }))
	.filter(({ line }) => line.includes("\r"))
	.map(({ index, line }) => `  ${path.relative(root, file)}:${index}: carriage return`);
if (controlChars.length > 0) {
	problems.push("control characters inside the Luau source:\n" + controlChars.join("\n"));
}

if (problems.length > 0) {
	console.error("generated Luau source is broken before Tern ever sees it:");
	for (const problem of problems) console.error(problem);
	process.exit(1);
}

console.log(`ok   generated Luau source is intact (${lua.split("\n").length} lines)`);
