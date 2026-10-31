/**
 * Identity and the 0.9 session verbs, tested without Tern.
 *
 * Every fixture here is a real answer from Tern 0.9.8, captured with `tern whoami --json` and
 * `tern process BLOCK --json` inside a pane of a headless `tern daemon`. The parsers are the part
 * that can be wrong in ways a live test would miss (an extra hop, a renamed field, a body that is
 * valid JSON but not an identity), so they are tested directly; the live plumbing is in
 * test/tern-live.test.ts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { describeIdentity, parseIdentity, readIdentityEnv } from "../lib/identity.ts";
import { dockBlock, keepPaneOpen, moveBlock, paneProcess, parsePaneProcess, pipBlock, renameTarget, type Runner } from "../lib/session.ts";
import type { RunResult } from "../lib/tern.ts";

/** `tern whoami --json`, verbatim from 0.9.8 in a local pane. */
const WHOAMI_LOCAL = {
	hops: [{ principal: "batra", method: "local", from: "", host: "Mayanks-MacBook-Pro", user: "batra" }],
};

/** `tern process BLOCK --json`, verbatim: the block's program and what holds the terminal now. */
const PROCESS = {
	pane: 3,
	child: { pid: 32228, name: "zsh", argv: ["/bin/zsh", "-l"], cwd: "/private/tmp" },
	group: 32228,
	foreground: { pid: 32228, name: "zsh", argv: ["/bin/zsh", "-l"], cwd: "/private/tmp" },
};

test("a local whoami answer becomes one identity, naming the principal and the host", () => {
	const identity = parseIdentity(WHOAMI_LOCAL);
	assert.ok(identity);
	assert.equal(identity.hops.length, 1);
	assert.equal(identity.principal, "batra");
	assert.equal(identity.host, "Mayanks-MacBook-Pro");
	assert.equal(identity.method, "local");
	assert.equal(identity.source, "cli");
	assert.equal(describeIdentity(identity), "batra@Mayanks-MacBook-Pro (local)");
});

test("a multi-hop chain keeps every hop and takes the last one as the identity", () => {
	// Not captured (this machine has no remote host): the shape is what a chain of hops means, and
	// the point is that a longer chain must not collapse into its first hop.
	const identity = parseIdentity({
		hops: [
			{ principal: "batra", method: "local", from: "", host: "laptop", user: "batra" },
			{ principal: "deploy", method: "ssh", from: "laptop", host: "vps", user: "deploy" },
		],
	});
	assert.ok(identity);
	assert.equal(identity.hops.length, 2);
	assert.equal(identity.principal, "deploy");
	assert.equal(identity.host, "vps");
	assert.equal(identity.method, "ssh");
	assert.match(describeIdentity(identity), /2 hops/);
});

test("a hop with fields this build does not know keeps them instead of flattening the chain", () => {
	const identity = parseIdentity({
		hops: [{ principal: "batra", method: "relay", host: "host", user: "batra", ticket: "T-1", expires: 42 }],
	});
	assert.ok(identity);
	assert.deepEqual(identity.hops[0]?.extra, { ticket: "T-1", expires: 42 });
});

test("what is not an identity is null, so nothing invents an attribution", () => {
	for (const raw of [null, {}, { hops: [] }, { hops: "x" }, [], "batra", { hops: [{}, {}] }]) {
		assert.equal(parseIdentity(raw), null, JSON.stringify(raw));
	}
});

test("TERN_IDENTITY is read without running anything, and a broken one is ignored", () => {
	const env = { TERN_IDENTITY: JSON.stringify(WHOAMI_LOCAL) } as NodeJS.ProcessEnv;
	const fromEnv = readIdentityEnv(env);
	assert.ok(fromEnv);
	assert.equal(fromEnv.source, "env");
	assert.equal(fromEnv.principal, "batra");

	assert.equal(readIdentityEnv({ TERN_IDENTITY: "{not json" } as NodeJS.ProcessEnv), null);
	assert.equal(readIdentityEnv({ TERN_IDENTITY: '{"hops":[]}' } as NodeJS.ProcessEnv), null);
	assert.equal(readIdentityEnv({} as NodeJS.ProcessEnv), null);
});

test("a process answer keeps child and foreground apart", () => {
	// A block started to run one command and now sitting at a prompt has both, and they differ —
	// collapsing them is how "what is this pane running" starts being wrong.
	const parsed = parsePaneProcess({
		pane: 9,
		child: { pid: 1, name: "sh", argv: ["sh", "-lc", "true"], cwd: "/" },
		foreground: { pid: 2, name: "zsh", argv: ["/bin/zsh"], cwd: "/tmp" },
	});
	assert.ok(parsed);
	assert.equal(parsed.pane, 9);
	assert.equal(parsed.child?.name, "sh");
	assert.equal(parsed.foreground?.name, "zsh");
	assert.equal(parsed.child?.argv[2], "true");
});

test("a process body without a pane is not a process answer", () => {
	assert.equal(parsePaneProcess({ child: { pid: 1 } }), null);
	assert.equal(parsePaneProcess({ pane: "x" }), null);
	assert.equal(parsePaneProcess(null), null);
});

/** A runner that records argv and answers with one body, so the wire shape is asserted without Tern. */
function fakeRunner(stdout: unknown, code = 0, stderr = ""): Runner & { calls: string[][] } {
	const calls: string[][] = [];
	const run = async (args: string[]): Promise<RunResult> => {
		calls.push(args);
		return { code, stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout), stderr, timedOut: false };
	};
	return Object.assign(run, { calls });
}

test("every session verb asks Tern for JSON and parses the answer", async () => {
	const run = fakeRunner(PROCESS);
	assert.deepEqual(await paneProcess(3, run), PROCESS, "the answer is parsed, not guessed at");
	assert.deepEqual(run.calls.at(-1), ["process", "3", "--json"]);

	await renameTarget("probe", "renamed", run);
	assert.deepEqual(run.calls.at(-1), ["rename", "probe", "renamed", "--json"]);

	await moveBlock(3, "below", 4, run);
	assert.deepEqual(run.calls.at(-1), ["move", "3", "below", "4", "--json"]);

	await moveBlock(3, "tab", "new-tab", run);
	assert.deepEqual(run.calls.at(-1), ["move", "3", "tab", "new-tab", "--json"]);

	await pipBlock(3, {}, run);
	assert.deepEqual(run.calls.at(-1), ["pip", "3", "--json"]);

	await pipBlock(3, { over: 4, corner: "tr" }, run);
	assert.deepEqual(run.calls.at(-1), ["pip", "3", "--over", "4", "--corner", "tr", "--json"]);

	await dockBlock(3, undefined, run);
	assert.deepEqual(run.calls.at(-1), ["dock", "3", "--json"]);

	await dockBlock(3, "left", run);
	assert.deepEqual(run.calls.at(-1), ["dock", "3", "left", "--json"]);

	await keepPaneOpen(3, false, run);
	assert.deepEqual(run.calls.at(-1), ["keep-open", "3", "off", "--json"]);
	await keepPaneOpen(3, true, run);
	assert.deepEqual(run.calls.at(-1), ["keep-open", "3", "on", "--json"]);
});

test("a refusal quotes Tern's own message instead of a stack trace", async () => {
	const refuse = fakeRunner("", 1, "tern pip: picture in picture needs a second block in its tab");
	await assert.rejects(() => pipBlock(3, {}, refuse), /needs a second block in its tab/);

	const garbage = fakeRunner("not json", 0);
	await assert.rejects(() => paneProcess(3, garbage), /did not answer with JSON/);

	const empty = fakeRunner({}, 0);
	await assert.rejects(() => paneProcess(3, empty), /answered with no pane/);
});

/**
 * A leading `-` is an option to Tern, not a name.
 *
 * Measured on 0.9.8: `tern rename "@focused" "--window=0"` swallows the value as a flag and then
 * fails with a usage error that names neither the flag nor the value, and `tern move --nonsense`
 * answers `unknown flag --nonsense`. `--` does not rescue it either (`tern rename -- A B` is still
 * a usage error), so an option-shaped value has to be refused here rather than escaped later. All
 * of these values come from a model through a deferred tool, which is exactly the caller that will
 * never notice the difference between "renamed the wrong tab" and "renamed nothing".
 */
test("a value that Tern would read as a flag is refused before it reaches Tern", async () => {
	const run = fakeRunner({});
	const cases: Array<[string, () => Promise<unknown>]> = [
		["block", () => paneProcess("--window=0", run)],
		["target", () => renameTarget("--window=0", "name", run)],
		["name", () => renameTarget("@focused", "--window=0", run)],
		["move destination", () => moveBlock(3, "below", "-1", run)],
		["pip over", () => pipBlock(3, { over: "-1" }, run)],
		["keep-open block", () => keepPaneOpen("-3", true, run)],
	];
	for (const [what, call] of cases) {
		await assert.rejects(call, /cannot start with '-'/, what);
	}
	assert.deepEqual(run.calls, [], "nothing was run");
});

test("ordinary values still reach Tern unchanged", async () => {
	const run = fakeRunner({});
	await renameTarget("@focused", "my-tab", run);
	assert.deepEqual(run.calls.at(-1), ["rename", "@focused", "my-tab", "--json"], "a hyphen inside a name is fine");
});
