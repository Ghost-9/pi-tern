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
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const libDir = path.join(root, "lib");
const problems = [];

/**
 * Every exported template literal in lib/ that holds Luau, found by naming convention rather than a
 * hand-written list — so a new plugin cannot be added without being checked.
 */
const luauSources = [];
for (const entry of readdirSync(libDir)) {
	if (!entry.endsWith(".ts")) continue;
	const file = path.join(libDir, entry);
	const source = readFileSync(file, "utf8");
	for (const match of source.matchAll(/export const (\w*_LUAU) = `([\s\S]*?)\n`;\n/g)) {
		luauSources.push({ name: match[1], file: path.relative(root, file), lua: match[2] });
	}
}

if (luauSources.length === 0) {
	console.error("no Luau templates found in lib/*.ts — the scan itself is wrong");
	process.exit(1);
}

for (const { name, file, lua } of luauSources) {
	const lines = lua.split("\n");
	const at = (index) => `  ${file}:${index + 1}: ${lines[index].trim().slice(0, 90)}`;

	// A bare backtick ends the literal. An escaped one (\`) reaches the Luau as a literal backtick
	// inside a comment, which is why the existing comments use them and why they are allowed.
	const bare = lines.map((line, i) => (/([^\\]|^)`/.test(line) ? i : -1)).filter((i) => i >= 0);
	if (bare.length > 0) {
		problems.push(
			`${name}: a bare backtick terminates the TypeScript template literal:\n${bare.map(at).join("\n")}` +
				"\n  Escape it as \\` if the comment genuinely needs one.",
		);
	}

	// A `${` in the Luau would be interpolated by TypeScript, silently substituting JS into Lua.
	// The plugin's own version interpolation is the one legitimate case.
	const interpolated = lines
		.map((line, i) => (line.includes("${") && !line.includes('"${PLUGIN_VERSION}"') ? i : -1))
		.filter((i) => i >= 0);
	if (interpolated.length > 0) {
		problems.push(`${name}: a \${...} is interpolated by TypeScript rather than reaching the plugin:\n${interpolated.map(at).join("\n")}`);
	}

	const carriage = lines.map((line, i) => (line.includes("\r") ? i : -1)).filter((i) => i >= 0);
	if (carriage.length > 0) {
		problems.push(`${name}: carriage returns inside the Luau source:\n${carriage.map(at).join("\n")}`);
	}
}

if (problems.length > 0) {
	console.error("generated Luau source is broken before Tern ever sees it:");
	for (const problem of problems) console.error(problem);
	process.exit(1);
}

console.log(
	`ok   generated Luau source is intact (${luauSources.length} template(s): ${luauSources
		.map((s) => `${s.name} ${s.lua.split("\n").length}L`)
		.join(", ")})`,
);
