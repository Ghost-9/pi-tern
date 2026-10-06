#!/usr/bin/env node
/**
 * Exercise the launcher's TSP handshake against a pane that answers *late*.
 *
 * The handshake is a race: on identical panes, `scripts/hello-probe.mjs` received Tern's 633-byte
 * reply immediately while `scripts/tsp-render.mjs` received nothing across six retries over 2.4 s.
 * The launcher used to make a single 700 ms attempt and fall back to stock pi silently, so native
 * mode engaged nondeterministically and nothing recorded why.
 *
 * This drives the real launcher with `PI_TERN_STOCK` pointed at a stub, answering its hello only on
 * the Nth attempt. It needs no Tern and no pty: the observable is whether the stub ran at all.
 * If it ran, the launcher decided not to go native — and because the launcher must never print
 * anything on that path (printing would break the "invisible outside Tern" guarantee), the stub's
 * presence is the only honest signal available.
 *
 *   node scripts/probe-retry-test.mjs
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeMessage } from "../native/tsp.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const launcher = path.join(here, "..", "native", "pi-tern.mjs");
const stub = path.join(here, "probe-stub.mjs");

const results = [];
const record = (name, ok, detail = "") => {
	results.push({ name, ok, detail });
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

/** A canned hello reply, in the shape Tern sends it (the DA1 answer follows the hello). */
const helloReply = () =>
	`${encodeMessage("r", { r: "hello", v: [1], app: "tern", ver: "0.5.1", kinds: ["col", "md"], features: [], credits: 2 })}\x1b[?62;52;c`;

/** Run the launcher, answering its hello on `answerOn` (1-based) or never. */
function runLauncher({ answerOn, attempts = 3, timeoutMs = 200 }) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [launcher, "--version"], {
			env: {
				...process.env,
				TERM_PROGRAM: "tern",
				TMUX: "",
				STY: "",
				ZELLIJ: "",
				PI_TERN_PROBE_ATTEMPTS: String(attempts),
				PI_TERN_PROBE_TIMEOUT_MS: String(timeoutMs),
				PI_TERN_STOCK: stub,
				PI_TERN_SKIP_KIND_CHECK: "1",
				PI_TERN_QUIET_PROBE: "1",
			},
			stdio: ["pipe", "pipe", "pipe"],
		});
		let out = "";
		let err = "";
		let hellos = 0;
		let answered = false;
		child.stdout.on("data", (chunk) => {
			const text = String(chunk);
			out += text;
			hellos += (text.match(/hello/g) ?? []).length;
			if (answerOn !== null && !answered && hellos >= answerOn) {
				answered = true;
				try {
					child.stdin.write(helloReply());
				} catch {
					/* the launcher may already have exited */
				}
			}
		});
		child.stderr.on("data", (chunk) => {
			err += String(chunk);
		});
		const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
		child.on("exit", (code) => {
			clearTimeout(timer);
			resolve({ code, out, err, hellos });
		});
	});
}

const fellBack = (out) => out.includes("stock-fallback");

record(
	"an unanswered handshake is retried rather than silently falling back",
	(await runLauncher({ answerOn: null, attempts: 3, timeoutMs: 150 })).hellos >= 2,
	`the launcher sent ${(await runLauncher({ answerOn: null, attempts: 3, timeoutMs: 150 })).hellos} hello frames for 3 configured attempts`,
);

{
	const late = await runLauncher({ answerOn: 3, attempts: 3, timeoutMs: 200 });
	record(
		"a reply arriving on the last attempt still goes native",
		late.hellos >= 3 && !fellBack(late.out),
		`${late.hellos} attempts sent, stock stub ${fellBack(late.out) ? "ran (fell back)" : "did not run (native)"}`,
	);
}

{
	const first = await runLauncher({ answerOn: 1, attempts: 3, timeoutMs: 200 });
	record(
		"a reply on the first attempt goes native without wasting retries",
		first.hellos === 1 && !fellBack(first.out),
		`${first.hellos} attempt(s) sent`,
	);
}

{
	const none = await runLauncher({ answerOn: null, attempts: 2, timeoutMs: 150 });
	record(
		"every attempt failing falls back to stock pi rather than hanging",
		fellBack(none.out) && none.code === 0,
		`exit ${none.code}, stub ${fellBack(none.out) ? "ran" : "did NOT run"}`,
	);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
