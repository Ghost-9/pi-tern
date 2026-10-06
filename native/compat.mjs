#!/usr/bin/env node
/**
 * Compatibility matrix: pi-tern must be invisible outside Tern.
 * Runs the real managed pi and the launcher in every non-interactive mode and
 * asserts clean output, no crash, and no TSP traffic.
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

rmSync(record, { force: true });
const version = spawnSync("pi", ["--version"], { encoding: "utf8" });
check("pi --version", /1\.\d+\.\d+/.test(version.stdout), version.stdout.trim());

const print = await run("pi", ["--no-session", "-p", "reply with exactly: OK"]);
check("pi -p (print)", print.code === 0 && print.stdout.includes("OK"), print.stdout.trim() || print.stderr.trim());

const json = await run("pi", ["--no-session", "--mode", "json", "-p", "reply with exactly: OK"]);
check("pi --mode json", json.code === 0 && json.stdout.includes('"'), `${json.stdout.slice(0, 80)} ${json.stderr.slice(0, 80)}`);

// pi's RPC mode keeps the stream open on extension UI requests until the client
// answers them, so a caller that closes stdin never receives the get_commands reply.
// Asserting on that reply is therefore a bad test — and the previous version of this
// file passed for the wrong reason (it matched the substring "tern"/"result" in
// unrelated output). The property this matrix exists for is different and testable:
// the launcher's stdio must be equivalent to stock pi's, with no TSP frame in either.
// pi RPC uses {id, type}, not JSON-RPC {id, method} — the method shape returns
// "Unknown command: undefined" and never answers.
const rpcInput = `${JSON.stringify({ id: 1, type: "get_commands" })}\n`;
const rpc = await run("pi", ["--no-session", "--mode", "rpc"], { input: rpcInput, timeoutMs: 12000 });
const launcherRpc = await run("node", [launcher, "--no-session", "--mode", "rpc"], { input: rpcInput, timeoutMs: 12000 });

/** Keep the JSON line *shapes*; drop the random ids so two runs can be compared. */
function shape(stream) {
	return stream
		.split("\n")
		.filter((line) => line.startsWith("{"))
		.map((line) => {
			try {
				const parsed = JSON.parse(line);
				return String(parsed.type ?? parsed.method ?? "?");
			} catch {
				return "unparsable";
			}
		})
		.join(",");
}

const stockShapes = shape(rpc.stdout);
const launcherShapes = shape(launcherRpc.stdout);
check(
	"pi --mode rpc emits only JSON lines, no TSP frames",
	stockShapes.length > 0 && !rpc.stdout.includes(TSP_PREFIX) && !stockShapes.includes("unparsable"),
	`${stockShapes.split(",").length} lines: ${stockShapes.slice(0, 90)}`,
);
check(
	"pi-tern --mode rpc is equivalent to stock pi",
	launcherShapes === stockShapes && !launcherRpc.stdout.includes(TSP_PREFIX),
	launcherShapes === stockShapes
		? `identical ${launcherShapes.split(",").length}-line shape sequence`
		: `stock=[${stockShapes.slice(0, 60)}] tern=[${launcherShapes.slice(0, 60)}]`,
);

const launcherPrint = await run("node", [launcher, "--no-session", "-p", "reply with exactly: OK"]);
check(
	"pi-tern -p falls back to stock (no probe)",
	launcherPrint.code === 0 && launcherPrint.stdout.includes("OK"),
	launcherPrint.stdout.trim() || launcherPrint.stderr.trim(),
);

check("no TSP traffic in any non-Tern mode", !existsSync(record), existsSync(record) ? readFileSync(record, "utf8").slice(0, 120) : "");

const failed = results.filter((entry) => !entry.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
