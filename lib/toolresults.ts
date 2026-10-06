/**
 * Classifying tool output into native Tern widgets.
 *
 * The transcript is a `rows` mirror, so everything a tool produced reaches the reader as plain text.
 * Tern has real widgets for the three shapes that matter — `tern.ui.diff`, `tern.ui.code` and
 * `tern.ui.test_summary` — and none of them were used. This decides which widget a tool result
 * belongs in, so the plugin can hand it over without parsing anything itself.
 *
 * The shape of each entry mirrors the widget's own signature, so the Luau stays a straight pass-
 * through. Anything unrecognised falls back to text rather than being forced into a widget it does
 * not fit: a diff widget given prose produces something worse than prose.
 */

/** How many results the panel keeps. Beyond this it is a log, not a panel. */
export const MAX_TOOL_RESULTS = 12;

/** Longest text we hand to a widget; Tern truncates poorly and a 200 KB diff is not a panel. */
const MAX_TEXT = 24_000;

export interface ToolResult {
	id: string;
	tool: string;
	kind: "diff" | "code" | "tests" | "text";
	at: string;
	diff?: string;
	path?: string;
	code?: string;
	lang?: string;
	tests?: { passed: number; failed: number; skipped: number; took?: string };
	text?: string;
}

/** A `diff --git`/`--- a/`+`+++ b/` header, or a bare unified hunk. */
const DIFF_HEADER = /^(diff --git |index [0-9a-f]{7,}|--- |\+\+\+ |@@ )/m;
/** At least one hunk, which is what actually makes it a diff rather than three files. */
const DIFF_HUNK = /^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/m;

/** Extension to grammar, for Tern's `diff(text, path)` and `code(text, lang)`. */
const LANGUAGES: Record<string, string> = {
	".ts": "typescript", ".tsx": "tsx", ".js": "javascript", ".jsx": "jsx", ".mjs": "javascript",
	".cjs": "javascript", ".py": "python", ".rb": "ruby", ".go": "go", ".rs": "rust", ".java": "java",
	".kt": "kotlin", ".swift": "swift", ".c": "c", ".h": "c", ".cpp": "cpp", ".hpp": "cpp",
	".cs": "csharp", ".php": "php", ".sh": "bash", ".bash": "bash", ".zsh": "bash", ".fish": "fish",
	".sql": "sql", ".json": "json", ".yaml": "yaml", ".yml": "yaml", ".toml": "toml",
	".md": "markdown", ".html": "html", ".css": "css", ".scss": "scss", ".lua": "lua",
	".vim": "vim", ".ex": "elixir", ".exs": "elixir", ".scala": "scala", ".hs": "haskell",
};

function extensionOf(filePath: string | undefined): string | undefined {
	if (!filePath) return undefined;
	const match = /\.([A-Za-z0-9]+)$/.exec(filePath);
	return match ? `.${match[1].toLowerCase()}` : undefined;
}

/** Best-effort language for a path, else undefined so Tern picks its own default. */
export function languageFor(filePath: string | undefined): string | undefined {
	const ext = extensionOf(filePath);
	return ext ? LANGUAGES[ext] : undefined;
}

/** Parse `12 passed`, `3 failed`, `1 skipped`, `in 1.4s` out of a test runner's tail. */
export function parseTestCounts(text: string): ToolResult["tests"] | null {
	const tail = text.slice(-4000);
	const passed = /\b(\d+)\s+passed\b/.exec(tail);
	const failed = /\b(\d+)\s+failed\b/.exec(tail);
	const skipped = /\b(\d+)\s+skipped\b/.exec(tail);
	// A runner that printed nothing countable is not a test summary; guessing would put a
	// confident-looking 0/0/0 meter in front of the reader.
	if (!passed && !failed && !skipped) return null;
	const took = /\bin\s+([\d.]+m?s)\b/.exec(tail)?.[1];
	return {
		passed: Number(passed?.[1] ?? 0),
		failed: Number(failed?.[1] ?? 0),
		skipped: Number(skipped?.[1] ?? 0),
		took,
	};
}

/** Pull a `-- path/to/file` out of a tool's arguments, so `diff(text, path)` gets the right grammar. */
export function pathFromToolInput(input: unknown): string | undefined {
	if (!input || typeof input !== "object") return undefined;
	const record = input as Record<string, unknown>;
	for (const key of ["path", "file_path", "filePath", "target", "notebook_path"]) {
		const value = record[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

/**
 * Turn one tool execution into a panel entry, or `null` when there is nothing worth showing.
 *
 * `null` is the common and correct answer: most tools in a session are reads whose output belongs in
 * the transcript, not in a fixed panel.
 */
export function classifyToolResult(input: {
	tool: string;
	output: string;
	toolInput?: unknown;
	at?: Date;
	seq?: number;
}): ToolResult | null {
	const text = String(input.output ?? "");
	const trimmed = text.trim();
	if (!trimmed) return null;

	const at = (input.at ?? new Date()).toISOString();
	const id = `${input.tool}-${input.seq ?? at}`;
	const path = pathFromToolInput(input.toolInput);

	// A diff is the highest-value case and the most unambiguous: a hunk header is not prose.
	if (DIFF_HUNK.test(trimmed) && DIFF_HEADER.test(trimmed)) {
		return { id, tool: input.tool, kind: "diff", at, diff: trimmed.slice(0, MAX_TEXT), path };
	}

	// A single file's contents: a diff with no hunks is just a new file, and `code` highlights it.
	const file = path ? trimTrailingNewlines(trimmed) : "";
	if (file && looksLikeSource(path, file)) {
		return { id, tool: input.tool, kind: "code", at, code: file.slice(0, MAX_TEXT), path, lang: languageFor(path) };
	}

	const tests = parseTestCounts(trimmed);
	if (tests && (tests.failed > 0 || /(?:\bfail|✗|×|not ok\b)/i.test(trimmed))) {
		return { id, tool: input.tool, kind: "tests", at, tests };
	}

	// Command output with no better shape still beats nothing, as muted text.
	return { id, tool: input.tool, kind: "text", at, text: trimmed.slice(0, 4000) };
}

function trimTrailingNewlines(value: string): string {
	return value.replace(/\s+$/, "");
}

/**
 * Whether this is plausibly source rather than a wall of prose.
 *
 * Deliberately conservative and cheap: a read tool that returned JSON, YAML or a config file should
 * get the code widget, and one that returned an error message should not.
 */
function looksLikeSource(filePath: string | undefined, text: string): boolean {
	if (!filePath || text.length < 2) return false;
	const ext = extensionOf(filePath);
	if (!ext) return false;
	// Errors are never source, however the file is named.
	if (/^(error|traceback|fatal)\b/im.test(text.slice(0, 200))) return false;
	if (!LANGUAGES[ext]) return false;
	const lines = text.split("\n");
	// Prose has long lines and blank-line-separated sentences; code rarely runs past ~400 columns.
	const longLines = lines.filter((line) => line.length > 400).length;
	if (longLines > 0) return false;
	const blankRatio = lines.filter((line) => line.trim() === "").length / Math.max(1, lines.length);
	return blankRatio < 0.4;
}

/** Keep the newest entries, de-duplicated by id. */
export function mergeToolResults(
	existing: ToolResult[],
	incoming: ToolResult | null,
	limit = MAX_TOOL_RESULTS,
): ToolResult[] {
	if (!incoming) return existing;
	const without = existing.filter((entry) => entry.id !== incoming.id);
	return [incoming, ...without].slice(0, limit);
}
