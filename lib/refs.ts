/**
 * File references in agent output.
 *
 * Tern's own rustdoc settles how these should be made clickable: **`file://` links
 * always open in Tern (a file block, …)**. So the job here is recognition — find the
 * paths an agent mentions, resolve them, and hand back absolute `file://` URLs that a
 * markdown node can carry.
 *
 * Pure functions, no pi or Tern imports, so this stays unit-testable.
 */
import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Extensions we will treat as a file reference even when the path does not exist yet. */
export const KNOWN_EXTENSIONS = new Set([
	"md",
	"markdown",
	"mdx",
	"txt",
	"rst",
	"org",
	"json",
	"jsonl",
	"ndjson",
	"yaml",
	"yml",
	"toml",
	"ini",
	"cfg",
	"env",
	"ts",
	"tsx",
	"js",
	"jsx",
	"mjs",
	"cjs",
	"py",
	"rs",
	"go",
	"rb",
	"java",
	"kt",
	"swift",
	"c",
	"h",
	"cc",
	"cpp",
	"hpp",
	"cs",
	"php",
	"lua",
	"sh",
	"bash",
	"zsh",
	"fish",
	"sql",
	"graphql",
	"proto",
	"css",
	"scss",
	"sass",
	"less",
	"html",
	"htm",
	"vue",
	"svelte",
	"astro",
	"xml",
	"csv",
	"tsv",
	"log",
	"mmd",
	"png",
	"jpg",
	"jpeg",
	"gif",
	"webp",
	"bmp",
	"svg",
	"pdf",
	"ipynb",
	"lock",
	"patch",
	"diff",
]);

export type RefKind = "markdown" | "image" | "pdf" | "code" | "data" | "other";

export interface FileRef {
	/** Exactly what the agent wrote. */
	raw: string;
	/** Absolute path, or undefined when a relative path could not be resolved. */
	abs?: string;
	/** `path:line:col` resolved, when the reference carried one. */
	line?: number;
	column?: number;
	exists: boolean;
	isDirectory: boolean;
	kind: RefKind;
	/** `file://` URL for a markdown link. */
	url?: string;
	/** How it was found. */
	source: "markdown-link" | "backtick" | "bare" | "file-url";
}

export function classify(extension: string): RefKind {
	switch (extension) {
		case "md":
		case "markdown":
		case "mdx":
		case "rst":
		case "org":
			return "markdown";
		case "png":
		case "jpg":
		case "jpeg":
		case "gif":
		case "webp":
		case "bmp":
		case "svg":
			return "image";
		case "pdf":
			return "pdf";
		case "json":
		case "jsonl":
		case "ndjson":
		case "yaml":
		case "yml":
		case "toml":
		case "csv":
		case "tsv":
			return "data";
		default:
			return KNOWN_EXTENSIONS.has(extension) ? "code" : "other";
	}
}

/** `file://` URLs, percent-encoded so spaces and unicode survive a round trip. */
export function fileUrl(abs: string): string {
	const encoded = abs
		.split(path.sep)
		.map((segment) => encodeURIComponent(segment))
		.join("/");
	return `file://${encoded.startsWith("/") ? "" : "/"}${encoded}`;
}

function expand(raw: string, cwd: string): string {
	let candidate = raw;
	if (candidate.startsWith("~/") || candidate === "~") {
		candidate = path.join(os.homedir(), candidate.slice(candidate === "~" ? 1 : 2));
	}
	return path.isAbsolute(candidate) ? path.normalize(candidate) : path.resolve(cwd, candidate);
}

const TRAILING = /[.,;:)\]}'"]+$/;

/** Strip markdown punctuation an author would not consider part of the path. */
function trim(raw: string): string {
	return raw.replace(TRAILING, "").trim();
}

function splitLineCol(raw: string): { base: string; line?: number; column?: number } {
	const match = /^(.*?):(\d+)(?::(\d+))?$/.exec(raw);
	if (!match) return { base: raw };
	return { base: match[1], line: Number(match[2]), column: match[3] ? Number(match[3]) : undefined };
}

const MD_LINK_RE = /\[[^\]]*\]\(([^)\s]+)\)/g;
const BACKTICK_RE = /`([^`\n]+)`/g;
const BARE_RE =
	/(?:^|[\s(["'])((?:~\/|\/|\.{1,2}\/)[^\s"'`)]+?|\b[\w.-]+\/[\w./-]+?\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?|[\w.-]+\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?)\b/g;
const FILE_URL_RE = /file:\/\/[^\s"'`)]+/g;

interface Candidate {
	raw: string;
	source: FileRef["source"];
}

function candidates(text: string): Candidate[] {
	const out: Candidate[] = [];
	const push = (raw: string, source: FileRef["source"]) => {
		const cleaned = trim(raw);
		if (cleaned) out.push({ raw: cleaned, source });
	};
	for (const match of text.matchAll(FILE_URL_RE)) push(match[0], "file-url");
	for (const match of text.matchAll(MD_LINK_RE)) push(match[1], "markdown-link");
	for (const match of text.matchAll(BACKTICK_RE)) push(match[1], "backtick");
	for (const match of text.matchAll(BARE_RE)) push(match[1], "bare");
	return out;
}

export interface ParseRefsOptions {
	cwd: string;
	/** Include references that do not exist on disk (default true). */
	includeMissing?: boolean;
	/** Keep only these kinds. */
	kindsOnly?: RefKind[];
	limit?: number;
}

function candidatePath(candidate: Candidate, cwd: string): { raw: string; abs?: string; line?: number; column?: number } {
	if (candidate.source === "file-url") {
		try {
			return { raw: candidate.raw, abs: decodeURIComponent(new URL(candidate.raw).pathname) };
		} catch {
			return { raw: candidate.raw };
		}
	}
	const { base, line, column } = splitLineCol(candidate.raw);
	if (base.includes("\n") || base.startsWith("http")) return { raw: candidate.raw };
	return { raw: candidate.raw, abs: expand(base, cwd), line, column };
}

/** Extract every plausible file reference from a chunk of agent output. */
export function parseFileRefs(text: string, options: ParseRefsOptions): FileRef[] {
	if (!text) return [];
	const seen = new Map<string, FileRef>();
	for (const candidate of candidates(text)) {
		const { raw, abs, line, column } = candidatePath(candidate, options.cwd);
		if (!abs) continue;
		if (abs.includes("://")) continue;
		const extension = path.extname(abs).replace(/^\./, "").toLowerCase();
		const fromBacktick =
			candidate.source === "backtick" || candidate.source === "markdown-link" || candidate.source === "file-url";
		const exists = existsSync(abs);
		// A bare, single-segment name ("notes.md") is only trusted when the file is
		// really there: otherwise `node.js` in prose becomes a file reference.
		const singleSegment = !candidate.raw.includes("/");
		if (!fromBacktick && singleSegment && !exists) continue;
		if (!KNOWN_EXTENSIONS.has(extension) && !exists) continue;

		let isDirectory = false;
		if (exists) {
			try {
				isDirectory = statSync(abs).isDirectory();
			} catch {
				isDirectory = false;
			}
		}
		if (isDirectory) continue;
		if (!exists && options.includeMissing === false) continue;

		const kind = classify(extension);
		if (options.kindsOnly && !options.kindsOnly.includes(kind)) continue;

		const existing = seen.get(abs);
		const ref: FileRef = {
			raw,
			abs,
			line,
			column,
			exists,
			isDirectory,
			kind,
			url: fileUrl(abs),
			source: candidate.source,
		};
		// Prefer an existing file, then a reference that carried a line number.
		if (!existing || (ref.exists && !existing.exists) || (ref.line !== undefined && existing.line === undefined)) {
			seen.set(abs, ref);
		}
	}
	const refs = [...seen.values()].sort((a, b) => Number(b.exists) - Number(a.exists) || a.raw.localeCompare(b.raw));
	return typeof options.limit === "number" ? refs.slice(0, Math.max(0, options.limit)) : refs;
}

/**
 * Rewrite bare references into `file://` markdown links so Tern's markdown renderer
 * makes them clickable. Existing links are left alone.
 */
export function linkifyFileRefs(text: string, refs: FileRef[]): string {
	let out = text;
	for (const ref of refs) {
		if (!ref.url || ref.source === "markdown-link" || ref.source === "file-url") continue;
		if (!ref.exists) continue;
		const raw = ref.raw;
		if (out.includes(`](${raw})`) || out.includes(`](${ref.url})`)) continue;
		if (raw.length < 3) continue;
		// Only replace standalone occurrences: a backticked or whitespace-delimited path.
		const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const pattern = new RegExp(`(?<![\\w/\`\\[])(\`?)${escaped}\\1(?![\\w/])`, "g");
		out = out.replace(pattern, (match, tick) => (tick ? `[\`${raw}\`](${ref.url})` : `[${raw}](${ref.url})`));
	}
	return out;
}

/** One-line list for a tool result or a status message. */
export function describeRefs(refs: FileRef[]): string {
	if (refs.length === 0) return "no file references found";
	return refs
		.map((ref) => `${ref.exists ? "•" : "·"} ${ref.raw}${ref.line !== undefined ? `:${ref.line}` : ""}${ref.exists ? "" : " (missing)"}`)
		.join("\n");
}
