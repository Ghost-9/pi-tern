/**
 * Run a shell command in Tern: a new visible pane (default) or an existing one.
 */
import { capturePane } from "./ctl.ts";
import { cleanShellBlock } from "./text.ts";
import { runTern } from "./tern.ts";

export interface RunShellResult {
	block: string;
	output: string;
	timedOut: boolean;
}

export interface RunShellOptions {
	block?: string;
	cwd?: string;
	waitSeconds?: number;
}

export async function runShellInTern(command: string, options: RunShellOptions = {}): Promise<RunShellResult> {
	const cleaned = cleanShellBlock(command);
	if (!cleaned) throw new Error("empty command");
	if (options.block) {
		const sent = await runTern(["run", options.block, cleaned], 15000);
		if (sent.code !== 0) throw new Error(sent.stderr.trim() || `tern run exited ${sent.code}`);
		return { block: options.block, output: "", timedOut: false };
	}
	const args = ["new", "tab", "--json", "--keep-open"];
	if (options.cwd) args.push("--cwd", options.cwd);
	args.push("--", "sh", "-lc", cleaned);
	const created = await runTern(args, 15000);
	if (created.code !== 0) throw new Error(created.stderr.trim() || `tern new tab exited ${created.code}`);
	let block = "";
	try {
		block = String((JSON.parse(created.stdout) as { block?: number }).block ?? "");
	} catch {
		/* fall through to the error below */
	}
	if (!block) throw new Error(`could not read the new pane id: ${created.stdout.slice(0, 200)}`);
	const waitSeconds = Math.max(1, options.waitSeconds ?? 120);
	const waited = await runTern(
		["wait", block, "--until", "exit", "--timeout", String(waitSeconds)],
		(waitSeconds + 10) * 1000,
	);
	const output = await capturePane(block, {});
	return { block, output: output.trimEnd(), timedOut: waited.code !== 0 || waited.timedOut };
}
