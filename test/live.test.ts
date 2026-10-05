// Live tests: run inside a Tern pane. Skipped everywhere else (including CI).
import { test } from "node:test";
import assert from "node:assert/strict";
import { browserOp } from "../lib/browser.ts";
import { readTernEnv } from "../lib/tern.ts";

const env = readTernEnv();
const canRun = env.inTern && !!env.paneSocket;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("browser relay open/state/close", { skip: !canRun ? "not inside Tern" : false }, async (t) => {
	const opened = (await browserOp(env, { op: "open", url: "data:text/html,<h1>pi-tern</h1>" }, 20000)) as {
		ok?: { block?: number };
	};
	assert.ok(opened.ok, JSON.stringify(opened));
	const block = opened.ok?.block;
	assert.equal(typeof block, "number");
	try {
		await wait(1000);
		const state = (await browserOp(env, { op: "state", block }, 15000)) as { ok?: { url?: string; loading?: boolean } };
		assert.ok(state.ok, JSON.stringify(state));
		assert.match(String(state.ok?.url), /^data:text\/html/);
		// Capture is best-effort: Tern's WebView returns `0×0` when the
		// picture-in-picture is not rendered (window or tab not visible).
		try {
			const capture = (await browserOp(env, { op: "capture", block }, 20000)) as {
				ok?: { data?: string; mime?: string };
			};
			assert.equal(capture.ok?.mime, "image/png");
			assert.ok(typeof capture.ok?.data === "string" && capture.ok.data.startsWith("iVBOR"), "PNG magic");
		} catch (error) {
			t.diagnostic(`capture unavailable in this window: ${error instanceof Error ? error.message : String(error)}`);
		}
	} finally {
		await browserOp(env, { op: "close", block }, 15000);
	}
});
