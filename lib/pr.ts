/**
 * Pull-request awareness through the `gh` CLI, plus a watch mode that runs in a
 * visible Tern pane (`gh pr checks --watch`) so a human can see it happen while
 * pi waits on the pane.
 *
 * Everything degrades to a clear message when `gh` is missing or unauthenticated.
 */
import { execFile } from "node:child_process";
import { capturePane } from "./ctl.ts";
import { runShellInTern } from "./run.ts";
import { runTern } from "./tern.ts";

export interface GhResult {
	code: number;
	stdout: string;
	stderr: string;
	missing: boolean;
}

export function gh(args: string[], cwd?: string, timeoutMs = 60000): Promise<GhResult> {
	return new Promise((resolve) => {
		execFile(
			"gh",
			args,
			{ cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
			(error, stdout, stderr) => {
				const err = error as (Error & { code?: number | string }) | null;
				resolve({
					code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
					stdout: stdout ?? "",
					stderr: stderr ?? "",
					missing: (err as { code?: string } | null)?.code === "ENOENT",
				});
			},
		);
	});
}

export interface GhStatus {
	available: boolean;
	version?: string;
	authenticated: boolean;
	detail?: string;
}

let ghStatusCache: { at: number; value: GhStatus } | undefined;

export async function ghStatus(refresh = false): Promise<GhStatus> {
	const now = Date.now();
	if (!refresh && ghStatusCache && now - ghStatusCache.at < 30000) return ghStatusCache.value;
	const version = await gh(["--version"], undefined, 10000);
	if (version.missing) {
		const value: GhStatus = { available: false, authenticated: false, detail: "`gh` is not installed" };
		ghStatusCache = { at: now, value };
		return value;
	}
	const auth = await gh(["auth", "status"], undefined, 15000);
	const value: GhStatus = {
		available: version.code === 0,
		version: version.stdout.split("\n")[0]?.trim(),
		authenticated: auth.code === 0,
		detail: auth.code === 0 ? undefined : auth.stderr.trim().split("\n")[0],
	};
	ghStatusCache = { at: now, value };
	return value;
}

async function requireGh(): Promise<void> {
	const status = await ghStatus();
	if (!status.available) throw new Error(`tern_pr needs the GitHub CLI: ${status.detail ?? "gh missing"}`);
	if (!status.authenticated) {
		throw new Error(`tern_pr needs an authenticated GitHub CLI: ${status.detail ?? "run `gh auth login`"}`);
	}
}

export interface PrSummary {
	number?: number;
	title?: string;
	url?: string;
	state?: string;
	mergeable?: string;
	reviewDecision?: string;
	isDraft?: boolean;
	baseRefName?: string;
	headRefName?: string;
	additions?: number;
	deletions?: number;
	changedFiles?: number;
	comments?: number;
	checks: {
		total: number;
		passing: number;
		failing: number;
		pending: number;
		failingNames: string[];
		pendingNames: string[];
	};
}

const PR_FIELDS = [
	"number",
	"title",
	"url",
	"state",
	"mergeable",
	"reviewDecision",
	"isDraft",
	"baseRefName",
	"headRefName",
	"additions",
	"deletions",
	"changedFiles",
	"comments",
	"statusCheckRollup",
].join(",");

/** Summarize a PR, collapsing the noisy statusCheckRollup into counts. */
export async function prSummary(options: { cwd?: string; selector?: string }): Promise<PrSummary> {
	await requireGh();
	const selector = options.selector?.trim() || "";
	const args = ["pr", "view"];
	if (selector) args.push(selector);
	args.push("--json", PR_FIELDS);
	const result = await gh(args, options.cwd, 60000);
	if (result.code !== 0) {
		throw new Error(result.stderr.trim() || result.stdout.trim() || `gh pr view exited ${result.code}`);
	}
	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(result.stdout) as Record<string, unknown>;
	} catch {
		throw new Error(`gh pr view did not return JSON: ${result.stdout.slice(0, 200)}`);
	}
	const rollup = Array.isArray(raw.statusCheckRollup) ? (raw.statusCheckRollup as Array<Record<string, unknown>>) : [];
	let passing = 0;
	let failing = 0;
	let pending = 0;
	const failingNames: string[] = [];
	const pendingNames: string[] = [];
	for (const check of rollup) {
		const name = String(check.name ?? check.context ?? check.workflowName ?? "check");
		const conclusion = String(check.conclusion ?? check.state ?? "").toUpperCase();
		const status = String(check.status ?? "").toUpperCase();
		if (conclusion === "") {
			pending += 1;
			pendingNames.push(name);
		} else if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion)) {
			passing += 1;
		} else if (
			[
				"FAILURE",
				"FAILED",
				"ERROR",
				"CANCELLED",
				"TIMED_OUT",
				"ACTION_REQUIRED",
				"STARTUP_FAILURE",
				"STALE",
			].includes(conclusion)
		) {
			failing += 1;
			failingNames.push(name);
		} else {
			pending += 1;
			pendingNames.push(name);
		}
		void status;
	}
	return {
		number: raw.number as number | undefined,
		title: raw.title as string | undefined,
		url: raw.url as string | undefined,
		state: raw.state as string | undefined,
		mergeable: raw.mergeable as string | undefined,
		reviewDecision: (raw.reviewDecision as string | undefined) || undefined,
		isDraft: raw.isDraft as boolean | undefined,
		baseRefName: raw.baseRefName as string | undefined,
		headRefName: raw.headRefName as string | undefined,
		additions: raw.additions as number | undefined,
		deletions: raw.deletions as number | undefined,
		changedFiles: raw.changedFiles as number | undefined,
		comments: raw.comments as number | undefined,
		checks: { total: rollup.length, passing, failing, pending, failingNames, pendingNames },
	};
}

/** One-line readiness verdict — what a human would say out loud. */
export function prVerdict(summary: PrSummary): string {
	const parts: string[] = [];
	if (summary.isDraft) parts.push("draft");
	if (summary.state) parts.push(summary.state.toLowerCase());
	if (summary.reviewDecision) parts.push(summary.reviewDecision.toLowerCase().replace(/_/g, " "));
	if (summary.checks.failing > 0) parts.push(`${summary.checks.failing} failing check${summary.checks.failing === 1 ? "" : "s"}`);
	else if (summary.checks.total > 0 && summary.checks.pending === 0) parts.push("checks green");
	if (summary.mergeable) parts.push(summary.mergeable.toLowerCase().replace(/_/g, " "));
	return parts.join(" · ") || "no signal";
}

export async function prList(options: { cwd?: string; limit?: number; state?: string } = {}): Promise<unknown> {
	await requireGh();
	const limit = Math.max(1, Math.min(options.limit ?? 10, 50));
	const args = ["pr", "list", "--limit", String(limit), "--json", "number,title,url,state,isDraft,headRefName,reviewDecision"];
	if (options.state) args.push("--state", options.state);
	const result = await gh(args, options.cwd, 60000);
	if (result.code !== 0) throw new Error(result.stderr.trim() || `gh pr list exited ${result.code}`);
	try {
		return JSON.parse(result.stdout);
	} catch {
		return result.stdout.trim();
	}
}

export interface PrWatchResult {
	pane?: number;
	output: string;
	exited: boolean;
	timedOut: boolean;
	summary?: PrSummary;
}

/**
 * A PR selector is a number, a URL, a branch, or `owner/repo#n`.
 *
 * It reaches a shell (`gh pr checks <selector> --watch` runs inside a visible Tern pane), so it is
 * validated to a conservative character set and single-quoted rather than interpolated raw —
 * otherwise a branch name containing `;` or `&` becomes a second command.
 */
export function safeSelector(selector: string | undefined): string {
	const trimmed = (selector ?? "").trim();
	if (trimmed === "") return "";
	if (!/^[A-Za-z0-9._~#:/@-]+$/.test(trimmed)) {
		throw new Error(
			`unsafe PR selector: ${JSON.stringify(trimmed)} — use a number, URL, or branch (letters, digits, . _ ~ # : / @ -)`,
		);
	}
	return `'${trimmed.replace(/'/g, `'\\''`)}'`;
}

/**
 * Run `gh pr checks --watch` in a visible Tern pane and wait for it to finish.
 * Falling back to a plain (invisible) run when Tern is unavailable keeps the tool
 * useful in CI.
 */
export async function prWatch(options: {
	cwd?: string;
	selector?: string;
	timeoutMs?: number;
	inPane?: boolean;
}): Promise<PrWatchResult> {
	await requireGh();
	const raw = (options.selector ?? "").trim();
	const quoted = safeSelector(raw);
	const command = `gh pr checks${quoted ? ` ${quoted}` : ""} --watch --interval 30`;
	if (options.inPane !== false) {
		try {
			const ran = await runShellInTern(command, {
				cwd: options.cwd,
				waitSeconds: Math.round((options.timeoutMs ?? 900000) / 1000),
			});
			let summary: PrSummary | undefined;
			try {
				summary = await prSummary({ cwd: options.cwd, selector: raw });
			} catch {
				/* the checks output is still the evidence */
			}
			return { pane: Number(ran.block) || undefined, output: ran.output, exited: !ran.timedOut, timedOut: ran.timedOut, summary };
		} catch {
			/* fall through to a direct run */
		}
	}
	const result = await gh(
		["pr", "checks", ...(raw ? [raw] : []), "--watch", "--interval", "30"],
		options.cwd,
		options.timeoutMs ?? 900000,
	);
	return {
		output: `${result.stdout}${result.stderr}`.trim(),
		exited: result.code === 0,
		timedOut: false,
	};
}

export interface PrComment {
	author?: string;
	body?: string;
	createdAt?: string;
	kind: "comment" | "review";
	path?: string;
}

/** Review comments and issue comments, newest last, bodies trimmed for the model. */
export async function prComments(options: { cwd?: string; selector?: string; limit?: number }): Promise<PrComment[]> {
	await requireGh();
	const selector = options.selector?.trim() || "";
	const args = ["pr", "view"];
	if (selector) args.push(selector);
	args.push("--json", "comments,reviews");
	const result = await gh(args, options.cwd, 60000);
	if (result.code !== 0) throw new Error(result.stderr.trim() || `gh pr view exited ${result.code}`);
	let raw: { comments?: Array<Record<string, unknown>>; reviews?: Array<Record<string, unknown>> };
	try {
		raw = JSON.parse(result.stdout) as typeof raw;
	} catch {
		throw new Error("gh pr view did not return JSON");
	}
	const limit = options.limit ?? 20;
	const out: PrComment[] = [];
	for (const comment of raw.comments ?? []) {
		out.push({
			author: String((comment.author as { login?: string })?.login ?? "?"),
			body: String(comment.body ?? "").slice(0, 2000),
			createdAt: String(comment.createdAt ?? ""),
			kind: "comment",
		});
	}
	for (const review of raw.reviews ?? []) {
		if (!String(review.body ?? "").trim()) continue;
		out.push({
			author: String((review.author as { login?: string })?.login ?? "?"),
			body: String(review.body ?? "").slice(0, 2000),
			createdAt: String(review.submittedAt ?? review.createdAt ?? ""),
			kind: "review",
		});
	}
	out.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
	return out.slice(-limit);
}

/** Best-effort: open the PR page in Tern's browser. */
export async function openPrInBrowser(env: { paneId?: string; paneSocket?: string }, url: string): Promise<number | undefined> {
	const owner = env.paneId ? Number(env.paneId) : undefined;
	const args = ["browser", JSON.stringify({ op: "open", url, ...(owner ? { owner } : {}) }), "--json"];
	const result = await runTern(args, 15000);
	if (result.code !== 0) return undefined;
	try {
		const parsed = JSON.parse(result.stdout) as { ok?: { block?: number } };
		return parsed.ok?.block;
	} catch {
		return undefined;
	}
}

/** Read a pane's text once (used by the fleet/pr watch paths). */
export async function paneText(block: string | number): Promise<string> {
	return capturePane(String(block), { scrollback: true });
}
