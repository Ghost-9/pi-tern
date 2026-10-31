/**
 * Live Tern tests that need no GUI — and skip, with a reason, when Tern is not installed.
 *
 * Tern 0.9's developer tooling makes the CLI testable headlessly: `tern serve` is a window without a
 * screen on a control endpoint, `tern ctl` is one command into it, and `tern daemon` keeps panes
 * alive with no window at all. Before this file, every Tern-dependent claim in the suite came from a
 * fake `tern` shell script (`test/protocol.test.ts`), so the *wire* was tested and the *contract*
 * was not: the words a real build accepts, the JSON it prints, and the identity it reports.
 *
 * Everything is isolated with `TERN_CONFIG_DIR` and a socket inside a temp directory: a test run must
 * never read or write the developer's Tern settings, plugins or sessions. Measured against Tern
 * 0.9.8 (f21d9a3); a build that cannot start (no display, no account) skips rather than fails — a
 * sandbox without a screen is not a regression in pi-tern.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { BRIDGE_PLUGIN_TOML, BRIDGE_WINDOW_LUAU } from "../lib/bridge-plugin.ts";
import { TOOLS_WINDOW_LUAU } from "../lib/tools-plugin.ts";
import { parseIdentity } from "../lib/identity.ts";
import { checkApi } from "../lib/luau-api.ts";
import { PLUGIN_VERSION } from "../lib/version.ts";

// ── availability ─────────────────────────────────────────────────────────────────────────────

const versionProbe = spawnSync("tern", ["--version"], { encoding: "utf8", timeout: 5000 });
const TERN_TEXT = `${versionProbe.stdout ?? ""}${versionProbe.stderr ?? ""}`.trim();
const TERN_AVAILABLE = versionProbe.status === 0 && /tern/i.test(TERN_TEXT);
const noTern = TERN_AVAILABLE
	? false
	: `Tern is not installed (or \`tern --version\` did not answer): ${TERN_TEXT || versionProbe.error?.message || "no output"}`;

/** A temp config/socket directory plus the environment that keeps Tern inside it. */
function isolate(): { dir: string; env: NodeJS.ProcessEnv; cleanup(): void } {
	const dir = mkdtempSync(path.join(os.tmpdir(), "pi-tern-live-"));
	return {
		dir,
		env: {
			...process.env,
			TERN_CONFIG_DIR: dir,
			TERN_DAEMON_SOCKET: path.join(dir, "daemon.sock"),
			// A Tern pane's variables would otherwise leak into the child and make `whoami` answer
			// about the wrong pane — or make the test pass for the wrong reason.
			TERN_PANE: "",
			TERN_PANE_SOCKET: "",
			TERN_IDENTITY: "",
		},
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function run(args: string[], env: NodeJS.ProcessEnv, timeoutMs = 20000): { code: number; stdout: string; stderr: string } {
	const result = spawnSync("tern", args, { encoding: "utf8", timeout: timeoutMs, env });
	return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function json<T = unknown>(args: string[], env: NodeJS.ProcessEnv, timeoutMs?: number): T {
	const result = run(args, env, timeoutMs);
	assert.equal(result.code, 0, `tern ${args.join(" ")} exited ${result.code}: ${result.stderr || result.stdout}`);
	try {
		return JSON.parse(result.stdout) as T;
	} catch {
		throw new Error(`tern ${args.join(" ")} did not answer with JSON: ${result.stdout.slice(0, 200)}`);
	}
}

/** Poll until `check()` returns a value, or the deadline passes. */
async function until<T>(check: () => T | undefined, timeoutMs: number): Promise<T | undefined> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = check();
		if (value !== undefined) return value;
		if (Date.now() > deadline) return undefined;
		await sleep(150);
	}
}

function collect(child: ChildProcess): () => string {
	let log = "";
	child.stdout?.on("data", (chunk: Buffer) => (log += chunk.toString("utf8")));
	child.stderr?.on("data", (chunk: Buffer) => (log += chunk.toString("utf8")));
	return () => log;
}

// ── a headless window: `tern serve` + `tern ctl` ─────────────────────────────────────────────

test("a headless Tern window answers the control endpoint", { skip: noTern }, async (t) => {
	const { dir, env, cleanup } = isolate();
	const socket = path.join(dir, "control.sock");
	const child = spawn("tern", ["serve", "--control", socket], { env, stdio: ["ignore", "pipe", "pipe"] });
	const log = collect(child);
	try {
		const state = await until(() => {
			const answer = run(["ctl", "--control", socket, "state"], env, 4000);
			if (answer.code !== 0) return undefined;
			try {
				return JSON.parse(answer.stdout) as { ok?: boolean; tabs?: unknown[]; panes?: unknown[] };
			} catch {
				return undefined;
			}
		}, 25000);
		if (!state) {
			// No display, no account, or a build that will not start: skip rather than fail.
			t.skip(`tern serve did not answer on ${socket}: ${log().trim().slice(0, 300) || "no output"}`);
			return;
		}
		assert.equal(state.ok, true);
		assert.ok(Array.isArray(state.tabs) && state.tabs.length > 0, "the served window has a tab");
		assert.ok(Array.isArray(state.panes) && state.panes.length > 0, "and a pane");

		const tree = json<{ ok?: boolean; tree?: Array<{ id?: string }> }>(["ctl", "--control", socket, "tree"], env);
		assert.equal(tree.ok, true);
		assert.ok(Array.isArray(tree.tree) && tree.tree.length > 0, "the DOM is inspectable, which is what tern_ctl relies on");

		const quit = run(["ctl", "--control", socket, "quit"], env);
		assert.equal(quit.code, 0, "`tern ctl quit` stops the session");
	} finally {
		child.kill("SIGKILL");
		cleanup();
	}
});

// ── the daemon, the plugin and its JSON ─────────────────────────────────────────────────────

test("Tern 0.9 loads the pi-bridge plugin, and says so in JSON", { skip: noTern }, async (t) => {
	const { dir, env, cleanup } = isolate();
	const socket = path.join(dir, "daemon.sock");
	const daemon = spawn("tern", ["daemon", "--socket", socket], { env, stdio: ["ignore", "pipe", "pipe"] });
	const log = collect(daemon);
	try {
		const ready = await until(() => {
			const answer = run(["plugin", "list", "--json"], env, 4000);
			if (answer.code !== 0) return undefined;
			try {
				JSON.parse(answer.stdout);
				return true;
			} catch {
				return undefined;
			}
		}, 25000);
		if (!ready) {
			t.skip(`tern daemon did not answer on ${socket}: ${log().trim().slice(0, 300) || "no output"}`);
			return;
		}

		// Write exactly what the extension ships, and link it the way `linkBridge()` does.
		const pkg = path.join(dir, "pi-bridge");
		mkdirSync(pkg, { recursive: true });
		writeFileSync(path.join(pkg, "plugin.toml"), BRIDGE_PLUGIN_TOML, "utf8");
		writeFileSync(path.join(pkg, "window.luau"), BRIDGE_WINDOW_LUAU, "utf8");

		const linked = json<{ id?: string; version?: string; dir?: string }>(["plugin", "link", pkg, "--json"], env);
		assert.equal(linked.id, "pi-bridge");
		assert.equal(linked.version, PLUGIN_VERSION, "Tern read the version pi-tern ships, not a copy of it");

		const reloaded = json<{ plugins?: Array<{ id?: string; version?: string; status?: string }>; problems?: unknown[] }>(
			["plugin", "reload", "--json"],
			env,
		);
		const bridge = reloaded.plugins?.find((plugin) => plugin.id === "pi-bridge");
		assert.ok(bridge, "the reloaded plugin list contains pi-bridge");
		assert.equal(bridge?.version, PLUGIN_VERSION);
		assert.deepEqual(reloaded.problems, [], "Tern reported no plugin problems");
		// This is the field `bridgeStatus()` now treats as a load result. A window entry is compiled
		// when a window starts, so `ready` here proves the *manifest* loaded — not that the Luau ran.
		if (bridge?.status !== undefined) assert.equal(bridge.status, "ready");
	} finally {
		daemon.kill("SIGKILL");
		cleanup();
	}
});

// ── identity and process introspection, in a real pane ─────────────────────────────────────

test("a real pane answers `whoami --json` and `process --json`", { skip: noTern }, async (t) => {
	const { dir, env, cleanup } = isolate();
	const socket = path.join(dir, "daemon.sock");
	const daemon = spawn("tern", ["daemon", "--socket", socket], { env, stdio: ["ignore", "pipe", "pipe"] });
	const log = collect(daemon);
	const whoamiFile = path.join(dir, "whoami.json");
	try {
		const ready = await until(() => {
			const answer = run(["ls", "--json"], env, 4000);
			return answer.code === 0 ? true : undefined;
		}, 25000);
		if (!ready) {
			t.skip(`tern daemon did not answer on ${socket}: ${log().trim().slice(0, 300) || "no output"}`);
			return;
		}

		// The identity a 0.9 pane reports for itself, written out by the pane's own shell.
		const created = run(["new", "session", "identity", "--", "sh", "-lc", `tern whoami --json > '${whoamiFile}'; sleep 20`, "--keep-open"], env);
		if (created.code !== 0) {
			t.skip(`could not create a pane in the headless daemon: ${created.stderr.trim() || created.stdout.trim()}`);
			return;
		}

		const written = await until(() => (existsSync(whoamiFile) ? readFileSync(whoamiFile, "utf8") : undefined), 20000);
		if (!written) {
			t.skip(`the pane never wrote ${whoamiFile}: ${log().trim().slice(0, 300) || "no daemon output"}`);
			return;
		}
		const identity = parseIdentity(JSON.parse(written) as unknown);
		assert.ok(identity, `whoami answered an identity chain: ${written.slice(0, 200)}`);
		assert.ok(identity.hops.length > 0);
		assert.ok((identity.principal ?? "").length > 0, "the chain names a principal");
		assert.ok((identity.host ?? "").length > 0, "and a host");

		// `process` on the same session: the block's program is the shell we asked for.
		const sessions = json<{ sessions?: Array<{ name?: string; tabs?: Array<{ blocks?: Array<{ id?: number; command?: string }> }> }> }>(
			["ls", "--json"],
			env,
		);
		const session = sessions.sessions?.find((entry) => entry.name === "identity");
		const blockId = session?.tabs?.flatMap((tab) => tab.blocks ?? []).map((block) => block.id).find((id) => typeof id === "number");
		if (blockId === undefined) {
			t.skip("the created session has no block id yet");
			return;
		}
		const process = json<{ pane?: number; child?: { argv?: string[]; cwd?: string }; foreground?: { name?: string } }>(
			["process", String(blockId), "--json"],
			env,
		);
		assert.equal(process.pane, blockId);
		assert.ok(process.child?.argv?.length, "the process answer carries the argv it was started with");
		assert.ok((process.child?.cwd ?? "").length > 0, "and its cwd");
	} finally {
		daemon.kill("SIGKILL");
		cleanup();
	}
});

// ── the plugin API the Luau is compiled against ─────────────────────────────────────────────

test("the installed Tern still declares every symbol the shipped Luau uses", { skip: noTern }, async (t) => {
	const { dir, env, cleanup } = isolate();
	try {
		const written = run(["plugin", "types", dir], env);
		if (written.code !== 0) {
			// 0.5.x has no `plugin types`; that is the version boundary, not a failure.
			t.skip(`this Tern has no \`plugin types\`: ${(written.stderr || written.stdout).trim().slice(0, 200)}`);
			return;
		}
		const declaration = readFileSync(path.join(dir, "tern.d.luau"), "utf8");
		const result = checkApi(declaration, [BRIDGE_WINDOW_LUAU, TOOLS_WINDOW_LUAU]);
		assert.ok(result.used >= 60, `the extractor read ${result.used} symbols from the Luau`);
		assert.deepEqual(result.missing, [], `this Tern no longer declares: ${result.missing.join(", ")}`);
	} finally {
		cleanup();
	}
});

// ── `tern shot`: goldens, when the machine can produce them ─────────────────────────────────

test("tern shot writes PNG + layout JSON goldens when its fixtures are available", { skip: noTern }, async (t) => {
	const { dir, env, cleanup } = isolate();
	const out = path.join(dir, "shots");
	try {
		const result = spawnSync("tern", ["shot", "single", "--out", out, "--theme", "both"], {
			encoding: "utf8",
			timeout: 120000,
			env,
		});
		const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
		if (result.status !== 0) {
			// Measured on 0.9.8: `tern shot` refuses without STENCIL_FIXTURE_ROOT, which only exists
			// in Tern's own source tree. That is a property of this machine, not of pi-tern.
			t.skip(`tern shot needs the app crate's goldens (STENCIL_FIXTURE_ROOT): ${output.slice(0, 300) || `exit ${result.status}`}`);
			return;
		}
		const files = readdirSync(out, { recursive: true }).map(String);
		assert.ok(files.some((file) => file.endsWith(".png")), `a PNG was written: ${files.slice(0, 10).join(", ")}`);
		assert.ok(files.some((file) => file.endsWith(".json")), "and its layout JSON");
	} finally {
		cleanup();
	}
});
