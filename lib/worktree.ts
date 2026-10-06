/**
 * Git worktrees as a first-class workspace, the way T3 Code treats them.
 *
 * Pure git — no Tern dependency. The optional `pane` flag opens the new worktree
 * in a Tern tab through the CLI, which works wherever the daemon answers.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { runTern } from "./tern.ts";

export interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
}

export function git(args: string[], cwd?: string, timeoutMs = 30000): Promise<GitResult> {
	return new Promise((resolve) => {
		execFile(
			"git",
			args,
			{ cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" },
			(error, stdout, stderr) => {
				const err = error as (Error & { code?: number | string }) | null;
				resolve({
					code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
					stdout: stdout ?? "",
					stderr: stderr ?? "",
				});
			},
		);
	});
}

export async function repoRoot(cwd?: string): Promise<string> {
	const result = await git(["rev-parse", "--show-toplevel"], cwd, 10000);
	if (result.code !== 0) {
		throw new Error(result.stderr.trim() || `not a git repository (cwd: ${cwd ?? process.cwd()})`);
	}
	return result.stdout.trim();
}

export async function currentBranch(cwd?: string): Promise<string> {
	const result = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd, 10000);
	return result.code === 0 ? result.stdout.trim() : "";
}

export interface WorktreeEntry {
	path: string;
	head?: string;
	branch?: string;
	detached: boolean;
	bare: boolean;
	locked?: boolean;
	prunable?: boolean;
}

/** `git worktree list --porcelain`, parsed. */
export async function worktreeList(cwd?: string): Promise<WorktreeEntry[]> {
	const root = await repoRoot(cwd);
	const result = await git(["worktree", "list", "--porcelain"], root, 15000);
	if (result.code !== 0) throw new Error(result.stderr.trim() || `git worktree list exited ${result.code}`);
	const entries: WorktreeEntry[] = [];
	let current: WorktreeEntry | null = null;
	for (const raw of result.stdout.split("\n")) {
		const line = raw.trimEnd();
		if (!line) {
			if (current) entries.push(current);
			current = null;
			continue;
		}
		const [key, ...rest] = line.split(" ");
		const value = rest.join(" ");
		if (key === "worktree") {
			if (current) entries.push(current);
			current = { path: value, detached: false, bare: false };
			continue;
		}
		if (!current) continue;
		if (key === "HEAD") current.head = value;
		else if (key === "branch") current.branch = value.replace(/^refs\/heads\//, "");
		else if (key === "detached") current.detached = true;
		else if (key === "bare") current.bare = true;
		else if (key === "locked") current.locked = true;
		else if (key === "prunable") current.prunable = true;
	}
	if (current) entries.push(current);
	return entries;
}

/** Where a worktree for `branch` goes: a sibling directory of the repository. */
export function defaultWorktreePath(root: string, branch: string): string {
	const slug = branch.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "worktree";
	return path.join(path.dirname(root), `${path.basename(root)}.wt.${slug}`);
}

export async function branchExists(root: string, branch: string): Promise<boolean> {
	const result = await git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], root, 10000);
	return result.code === 0;
}

export interface WorktreeAddOptions {
	cwd?: string;
	branch: string;
	/** Where the new branch starts. Defaults to HEAD. Ignored when the branch exists. */
	baseRef?: string;
	path?: string;
	/** Use the existing local branch instead of creating one. */
	useExistingBranch?: boolean;
	/** Fetch origin/<baseRef> first and start from the remote commit. */
	startFromOrigin?: boolean;
}

export interface WorktreeAddResult {
	path: string;
	branch: string;
	base: string;
	created: boolean;
	root: string;
}

export async function worktreeAdd(options: WorktreeAddOptions): Promise<WorktreeAddResult> {
	const root = await repoRoot(options.cwd);
	const branch = options.branch.trim();
	if (!branch) throw new Error("branch is required");
	const target = options.path ? path.resolve(root, options.path) : defaultWorktreePath(root, branch);
	if (existsSync(target)) throw new Error(`path already exists: ${target}`);

	// Refresh the worktree bookkeeping so a deleted directory does not block us.
	await git(["worktree", "prune"], root, 15000);

	const exists = await branchExists(root, branch);
	const args = ["worktree", "add"];
	if (!exists) {
		let base = options.baseRef ?? "HEAD";
		if (options.startFromOrigin) {
			const ref = options.baseRef ?? "HEAD";
			const fetched = await git(["fetch", "origin", ref], root, 120000);
			if (fetched.code === 0) base = `origin/${ref}`;
		}
		args.push("-b", branch, target, base);
	} else {
		if (!options.useExistingBranch) {
			throw new Error(`branch '${branch}' already exists — pass useExistingBranch to check it out`);
		}
		args.push(target, branch);
	}
	const result = await git(args, root, 120000);
	if (result.code !== 0) {
		throw new Error(result.stderr.trim() || result.stdout.trim() || `git worktree add exited ${result.code}`);
	}
	return {
		path: target,
		branch,
		base: exists ? branch : (options.baseRef ?? "HEAD"),
		created: !exists,
		root,
	};
}

export async function worktreeRemove(options: { cwd?: string; path: string; force?: boolean }): Promise<string> {
	const root = await repoRoot(options.cwd);
	const args = ["worktree", "remove"];
	if (options.force) args.push("--force");
	args.push(path.resolve(root, options.path));
	const result = await git(args, root, 60000);
	if (result.code !== 0) {
		throw new Error(result.stderr.trim() || result.stdout.trim() || `git worktree remove exited ${result.code}`);
	}
	return `removed ${options.path}`;
}

export async function worktreePrune(cwd?: string): Promise<string> {
	const root = await repoRoot(cwd);
	const result = await git(["worktree", "prune", "--verbose"], root, 30000);
	if (result.code !== 0) throw new Error(result.stderr.trim() || `git worktree prune exited ${result.code}`);
	return result.stdout.trim() || "pruned";
}

/** A one-line summary of each worktree: branch, dirty state, ahead/behind the base. */
export async function worktreeStatus(entry: WorktreeEntry): Promise<{ dirty: number; ahead?: number; behind?: number }> {
	const porcelain = await git(["status", "--porcelain"], entry.path, 15000);
	const dirty = porcelain.code === 0 ? porcelain.stdout.split("\n").filter((line) => line.trim()).length : 0;
	return { dirty };
}

/** Open a worktree as a Tern tab running a login shell in that directory. */
export async function openWorktreePane(target: string, shell = "$SHELL"): Promise<number | undefined> {
	const args = ["new", "tab", "--json", "--keep-open", "--cwd", target, "--", "sh", "-lc", `exec ${shell} -l`];
	const created = await runTern(args, 15000);
	if (created.code !== 0) return undefined;
	try {
		const parsed = JSON.parse(created.stdout) as { block?: number };
		return typeof parsed.block === "number" ? parsed.block : undefined;
	} catch {
		return undefined;
	}
}
