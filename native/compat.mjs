#!/usr/bin/env node
/**
 * Compatibility matrix: pi-tern must be invisible outside Tern.
 * Runs the real managed pi and the launcher in every non-interactive mode and
 * asserts clean output, no crash, and no TSP traffic.
 *
 * Two tiers, because CI cannot run the model-calling half:
 *
 *   node native/compat.mjs            every check (needs `pi` on PATH and a working model)
 *   node native/compat.mjs --static   only the checks that need no model call
 *
 * The static tier is what GitHub Actions runs. It covers the property that actually broke: the
 * launcher's stdio must be shape-identical to stock pi's, with no TSP frame in either stream. The
 * full tier additionally asserts that `pi -p` still returns a model reply, which needs credentials,
 * so it stays a local gate step where those exist.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const launcher = path.join(root, "native", "pi-tern.mjs");
const results = [];
const record = "/tmp/pi-tern-compat-record.jsonl";
const TSP_PREFIX = "\x1b_tsp;";

/**
 * Find the real pi. PATH first, because a developer's managed install is what this matrix is about;
 * then node_modules/.bin, because `@earendil-works/pi-coding-agent` is a devDependency so the
 * stock binary is available in CI even where nothing is globally installed.
 */
function resolvePi() {
	const fromPath = spawnSync("sh", ["-c", "command -v pi"], { encoding: "utf8" });
	const found = fromPath.stdout.trim();
	if (found) return found;
	const local = path.join(root, "node_modules", ".bin", "pi");
	return existsSync(local) ? local : null;
}

const PI = resolvePi();
if (!PI) {
	console.error("FATAL: no `pi` binary found, on PATH or in node_modules/.bin.");
	console.error("pi-tern's compat matrix compares the launcher against the real stock pi.");
	console.error("Install pi, or run `npm install` so the devDependency provides it.");
	process.exit(1);
}

function run(command, args, { input, timeoutMs = 90000 } = {}) {
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, PI_TERN_TSP_RECORD: record },
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		if (input) child.stdin.write(input);
		child.stdin.end();
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		});
	});
}

function check(name, ok, detail) {
	results.push({ name, ok, detail });
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail.slice(0, 140)}` : ""}`);
}

// --static skips only the checks that spend a model call. Everything else runs in both tiers.
const STATIC_ONLY = process.argv.includes("--static");
const label = STATIC_ONLY ? "static tier" : "full tier";

rmSync(record, { force: true });
console.log(`compatibility matrix (${label})\nusing pi: ${PI}\n`);

const version = spawnSync(PI, ["--version"], { encoding: "utf8" });
if (version.error || version.status !== 0) {
	// A loud, specific failure beats a cascade of confusing ones: without a working pi none of
	// the comparisons below mean anything.
	console.error(`FATAL: could not run \`pi --version\`: ${version.error?.message ?? `exit ${version.status}`}`);
	process.exit(1);
}
check("pi --version", /1\.\d+\.\d+/.test(version.stdout), version.stdout.trim());

if (!STATIC_ONLY) {
	const print = await run(PI, ["--no-session", "-p", "reply with exactly: OK"]);
	check("pi -p (print)", print.code === 0 && print.stdout.includes("OK"), print.stdout.trim() || print.stderr.trim());

	const json = await run(PI, ["--no-session", "--mode", "json", "-p", "reply with exactly: OK"]);
	check("pi --mode json", json.code === 0 && json.stdout.includes('"'), `${json.stdout.slice(0, 80)} ${json.stderr.slice(0, 80)}`);
}

// pi's RPC mode keeps the stream open on extension UI requests until the client
// answers them, so a caller that closes stdin never receives the get_commands reply.
// Asserting on that reply is therefore a bad test — and the previous version of this
// file passed for the wrong reason (it matched the substring "tern"/"result" in
// unrelated output). The property this matrix exists for is different and testable:
// the launcher's stdio must be equivalent to stock pi's, with no TSP frame in either.
// pi RPC uses {id, type}, not JSON-RPC {id, method} — the method shape returns
// "Unknown command: undefined" and never answers.
const rpcInput = `${JSON.stringify({ id: 1, type: "get_commands" })}\n`;
const rpc = await run(PI, ["--no-session", "--mode", "rpc"], { input: rpcInput, timeoutMs: 12000 });
const launcherRpc = await run("node", [launcher, "--no-session", "--mode", "rpc"], { input: rpcInput, timeoutMs: 12000 });

/** Keep the JSON line *shapes*; drop the random ids so two runs can be compared. */
/**
 * The *vocabulary* a stream speaks, not how many times.
 *
 * This originally compared the exact sequence and count of message types, and it flaked about one
 * run in three: `extension_ui_request` is pi asking an extension a UI question, and how many it asks
 * depends on the extension's own asynchronous work finishing. Both runs were correct; the counts
 * legitimately differed.
 *
 * So the property is the one the matrix exists for — the launcher's stdio speaks the same shapes as
 * stock pi's, and neither contains a TSP frame — while being immune to a count that is not a
 * contract. Run-to-run ordering of repeated UI round-trips is still significant, so the deduplicated
 * sequence is compared rather than the raw one.
 */
function shape(stream) {
	return [
		...new Set(
			stream
				.split("\n")
				.filter((line) => line.startsWith("{"))
				.map((line) => {
					try {
						const parsed = JSON.parse(line);
						return String(parsed.type ?? parsed.method ?? "?");
					} catch {
						return "unparsable";
					}
				}),
		),
	].join(",");
}

const stockShapes = shape(rpc.stdout);
const launcherShapes = shape(launcherRpc.stdout);
check(
	"pi --mode rpc emits only JSON lines, no TSP frames",
	stockShapes.length > 0 && !rpc.stdout.includes(TSP_PREFIX) && !stockShapes.includes("unparsable"),
	`${stockShapes.split(",").length} distinct shapes: ${stockShapes.slice(0, 90)}`,
);
check(
	"pi-tern --mode rpc is equivalent to stock pi",
	launcherShapes === stockShapes && !launcherRpc.stdout.includes(TSP_PREFIX),
	launcherShapes === stockShapes
		? `identical ${launcherShapes.split(",").length}-shape vocabulary`
		: `stock=[${stockShapes.slice(0, 60)}] tern=[${launcherShapes.slice(0, 60)}]`,
);

if (!STATIC_ONLY) {
	const launcherPrint = await run("node", [launcher, "--no-session", "-p", "reply with exactly: OK"]);
	check(
		"pi-tern -p falls back to stock (no probe)",
		launcherPrint.code === 0 && launcherPrint.stdout.includes("OK"),
		launcherPrint.stdout.trim() || launcherPrint.stderr.trim(),
	);
}

check("no TSP traffic in any non-Tern mode", !existsSync(record), existsSync(record) ? readFileSync(record, "utf8").slice(0, 120) : "");

const failed = results.filter((entry) => !entry.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed (${label})`);
if (STATIC_ONLY && results.length < 3) {
	// A "passing" static tier that checked almost nothing is the silent-skip failure mode again.
	console.error(`FATAL: the static tier only ran ${results.length} check(s); expected at least 3.`);
	process.exit(1);
}
process.exit(failed === 0 ? 0 : 1);
