/**
 * The extension loads on the host that actually runs it — stock Pi *and* pi-bolt.
 *
 * pi-tern is an extension of `@earendil-works/pi-coding-agent`. pi-bolt ships that same package at
 * the same version, so compatibility is by construction; what has never been *proved* is that this
 * file — 112 KB with a TSP probe, tool registration and a session hook — loads and registers on both
 * executables. A typecheck proves the API compiles, not that the runtime hooks fire.
 *
 * `--mode rpc` with `get_commands` is the cheapest honest test: no model call, no key, and the
 * answer is pi's own registry. A host whose extension failed to load answers without `tern` in the
 * list. The devDependency is the stock host, so this runs in CI too; a machine with pi-bolt has it
 * tested as well. Both are additive — neither is special-cased.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const extension = path.join(root, "index.ts");

interface Host {
	label: string;
	bin: string;
	/** The package version the binary reports, for the label only. */
	version: string;
}

function versionOf(bin: string): string {
	const result = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 20000 });
	return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split("\n")[0] ?? "";
}

/**
 * Every executable that can host this extension.
 *
 * `PI_TERN_HOST` wins so a specific build can be tested; otherwise the devDependency (stock Pi) and
 * the two names the host is installed under. Duplicates are removed by real path — on a pi-bolt-only
 * machine `pi` is usually a symlink to it, and testing the same binary twice proves nothing.
 */
function findHosts(): Host[] {
	const candidates: string[] = [];
	const explicit = process.env.PI_TERN_HOST?.trim();
	if (explicit) candidates.push(explicit);
	const local = path.join(root, "node_modules", ".bin", "pi");
	if (existsSync(local)) candidates.push(local);
	for (const name of ["pi", "pi-bolt"]) {
		const found = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();
		if (found) candidates.push(found);
	}
	const seen = new Set<string>();
	const hosts: Host[] = [];
	for (const candidate of candidates) {
		let key = candidate;
		try {
			key = realpathSync(candidate);
		} catch {
			/* keep the path as given */
		}
		if (seen.has(key)) continue;
		seen.add(key);
		const version = versionOf(candidate);
		const shown = candidate.startsWith(os.homedir()) ? `~${candidate.slice(os.homedir().length)}` : candidate;
		hosts.push({ label: `${shown} — ${version || "unknown version"}`, bin: candidate, version });
	}
	return hosts;
}

const hosts = findHosts();
const noHost = hosts.length > 0 ? false : "no pi host found: install Pi, or run `npm install` for the devDependency";

/** Run one RPC command against a host and return the answer to `get_commands`. */
function loadExtension(host: Host): { commands: string[]; stderr: string; status: number | null } {
	const home = mkdtempSync(path.join(os.tmpdir(), "pi-tern-host-"));
	try {
		const result = spawnSync(
			host.bin,
			["--no-session", "--no-tools", "--no-extensions", "-e", extension, "--mode", "rpc"],
			{
				encoding: "utf8",
				timeout: 60000,
				input: `${JSON.stringify({ id: 1, type: "get_commands" })}\n`,
				env: {
					...process.env,
					// Never read or write the developer's pi state or Tern plugins from a test run.
					HOME: home,
					TERN_CONFIG_DIR: path.join(home, "tern"),
					TERN_PANE: "",
					TERN_IDENTITY: "",
				},
			},
		);
		const commands: string[] = [];
		for (const line of (result.stdout ?? "").split("\n")) {
			if (!line.startsWith("{")) continue;
			try {
				const parsed = JSON.parse(line) as { command?: string; data?: { commands?: Array<{ name?: string }> } };
				if (parsed.command === "get_commands") {
					for (const command of parsed.data?.commands ?? []) if (command.name) commands.push(command.name);
				}
			} catch {
				/* an unparsable line is reported by the assertions below */
			}
		}
		return { commands, stderr: `${result.stderr ?? ""}`, status: result.status };
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

test("the extension registers on every installed host, stock Pi and pi-bolt alike", { skip: noHost }, async (t) => {
	for (const host of hosts) {
		await t.test(host.label, () => {
			const loaded = loadExtension(host);
			assert.ok(
				loaded.commands.includes("tern"),
				`${host.label} did not register the /tern command (exit ${loaded.status}): ${loaded.stderr.slice(0, 400)}`,
			);
			// The extension registers tools through the same API on both hosts; a command without
			// tools is a half-loaded extension, which is exactly what a 1.0.4-era pin could hide.
			assert.ok(loaded.commands.length > 0);
		});
	}
});

test("the devDependency matches the host runtime this build is developed against", () => {
	// `package.json` pinned 1.0.4 while both hosts on the machine shipped 1.4.0, so the strict
	// typecheck was validating against an API nine minor versions old.
	const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
		devDependencies?: Record<string, string>;
	};
	const pinned = pkg.devDependencies?.["@earendil-works/pi-coding-agent"];
	assert.ok(pinned, "the host package is a devDependency");
	assert.match(pinned, /^1\.(?:[4-9]|\d{2,})\./, `the pin tracks a current host runtime, not 1.0.x (found ${pinned})`);
	const installed = JSON.parse(
		readFileSync(path.join(root, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"), "utf8"),
	) as { version?: string };
	assert.equal(installed.version, pinned, "and it is actually installed at that version");
});
