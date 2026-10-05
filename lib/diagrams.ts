/**
 * Diagram pipelines: render mermaid produced by a command, and git history as a
 * mermaid gitGraph.
 */
import { execFile } from "node:child_process";
import { extractMermaids } from "./text.ts";

export interface CommandOutput {
	code: number;
	output: string;
}

export function runCommand(command: string, cwd?: string, timeoutMs = 60000): Promise<CommandOutput> {
	return new Promise((resolve) => {
		execFile(
			"sh",
			["-lc", command],
			{ cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
			(error, stdout, stderr) => {
				const err = error as (Error & { killed?: boolean }) | null;
				resolve({
					code: err ? 1 : 0,
					output: `${stdout ?? ""}${stderr ?? ""}`.trim(),
				});
			},
		);
	});
}

/** First mermaid fence from a command's output; the whole output when it has none. */
export function mermaidFromOutput(output: string): string {
	const found = extractMermaids(output);
	return found.length > 0 ? found[found.length - 1] : output;
}

/**
 * Generate a mermaid gitGraph from `git log` (newest commits become commits on the
 * current branch; merge commits are drawn as merge arrows where a parent is known).
 */
export async function gitGraphFromLog(cwd?: string, limit = 14): Promise<string> {
	const format = "%h|%p|%s";
	const result = await runCommand(`git log --max-count=${limit} --pretty=format:'${format}'`, cwd);
	if (result.code !== 0 || !result.output) return "gitGraph\n  commit id: \"no commits\"";
	const lines = result.output.split("\n").filter(Boolean);
	const rendered: string[] = ["gitGraph"];
	// git log is newest-first; render oldest-first so parents exist before children.
	const commits = lines
		.map((line) => {
			const [id, parents, subject] = line.split("|");
			return { id: (id ?? "").slice(0, 7), parents: (parents ?? "").split(" ").filter(Boolean), subject: subject ?? "" };
		})
		.reverse();
	const seen = new Set<string>();
	for (const commit of commits) {
		if (seen.has(commit.id)) continue;
		seen.add(commit.id);
		const parents = commit.parents.filter((parent) => seen.has(parent.slice(0, 7)));
		const label = commit.subject.replace(/["\n]/g, " ").slice(0, 48);
		if (parents.length === 0) {
			rendered.push(`  commit id: "${label} ${commit.id}"`);
		} else if (parents.length === 1) {
			rendered.push(`  commit id: "${label} ${commit.id}"`);
		} else {
			rendered.push(`  merge id: "${label} ${commit.id}"`);
		}
	}
	return rendered.join("\n");
}
