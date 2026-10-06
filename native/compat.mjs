#!/usr/bin/env node
/**
 * Compatibility matrix: pi-tern must be invisible outside Tern.
 * Runs the real managed pi and the launcher in every non-interactive mode and
 * asserts clean output, no crash, and no TSP traffic.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const root = path.resolve(new URL(".", import.meta.url).pathname, "..");
const launcher = path.join(root, "native", "pi-tern.mjs");
const results = [];
const record = "/tmp/pi-tern-compat-record.jsonl";

function run(command, args, { input, timeoutMs = 90000 } = {}) {
	return new Promise((resolve) => {
		const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PI_TERN_TSP_RECORD: record } });
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
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail.slice(0, 120)}` : ""}`);
}

rmSync(record, { force: true });
const version = spawnSync("pi", ["--version"], { encoding: "utf8" });
check("pi --version", /1\.\d+\.\d+/.test(version.stdout), version.stdout.trim());

const print = await run("pi", ["--no-session", "-p", "reply with exactly: OK"]);
check("pi -p (print)", print.code === 0 && print.stdout.includes("OK"), print.stdout.trim() || print.stderr.trim());

const json = await run("pi", ["--no-session", "--mode", "json", "-p", "reply with exactly: OK"]);
check("pi --mode json", json.code === 0 && json.stdout.includes('"'), `${json.stdout.slice(0, 80)} ${json.stderr.slice(0, 80)}`);

const rpc = await run("pi", ["--no-session", "--mode", "rpc"], {
	input: `${JSON.stringify({ id: 1, method: "get_commands" })}\n`,
	timeoutMs: 15000,
});
check(
	"pi --mode rpc responds to get_commands",
	rpc.stdout.includes("tern") || rpc.stdout.includes("commands") || rpc.stdout.includes("result"),
	`code=${rpc.code} out=${rpc.stdout.slice(0, 120)} err=${rpc.stderr.slice(0, 80)}`,
);

const launcherPrint = await run("node", [launcher, "--no-session", "-p", "reply with exactly: OK"]);
check("pi-tern -p falls back to stock (no probe)", launcherPrint.code === 0 && launcherPrint.stdout.includes("OK"), launcherPrint.stdout.trim());

const launcherRpc = await run("node", [launcher, "--no-session", "--mode", "rpc"], {
	input: `${JSON.stringify({ id: 1, method: "get_commands" })}\n`,
	timeoutMs: 15000,
});
check(
	"pi-tern --mode rpc does not touch stdio",
	launcherRpc.stdout.includes("tern") || launcherRpc.stdout.includes("commands") || launcherRpc.stdout.includes("result"),
	`code=${launcherRpc.code} out=${launcherRpc.stdout.slice(0, 120)}`,
);

check("no TSP traffic in any non-Tern mode", !existsSync(record), existsSync(record) ? readFileSync(record, "utf8").slice(0, 120) : "");

const failed = results.filter((entry) => !entry.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
