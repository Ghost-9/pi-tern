/**
 * Pure text helpers: Mermaid fence extraction and generic message rendering.
 * No pi imports so these stay unit-testable with plain Node.
 */

export const MERMAID_FENCE_RE = /```mermaid\s*\r?\n([\s\S]*?)```/g;

export function extractMermaids(text: string): string[] {
	if (!text) return [];
	const out: string[] = [];
	const re = new RegExp(MERMAID_FENCE_RE.source, "g");
	let match: RegExpExecArray | null;
	while ((match = re.exec(text)) !== null) {
		const body = match[1].trim();
		if (body) out.push(body);
	}
	return out;
}

/** Best-effort text of a pi message (content string or TextContent parts). */
export function messageText(message: unknown): string {
	const m = message as { content?: unknown } | null | undefined;
	if (!m) return "";
	const content = m.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => {
				const p = part as { type?: string; text?: string };
				return p?.type === "text" && typeof p.text === "string" ? p.text : "";
			})
			.filter(Boolean)
			.join("\n");
	}
	return "";
}

export function summarizeArgs(args: unknown, limit = 160): string {
	try {
		const s = typeof args === "string" ? args : JSON.stringify(args ?? {});
		if (!s || s === "{}") return "";
		return s.length > limit ? `${s.slice(0, limit)}…` : s;
	} catch {
		return "";
	}
}

/** Render one finalized message as a Markdown block for the session mirror. */
export function renderMessageMarkdown(message: unknown): string {
	const m = message as { role?: string; content?: unknown } | null | undefined;
	if (!m) return "";
	const role = m.role ?? "message";
	const text = messageText(m);
	if (!text && role === "user") return ""; // e.g. empty control messages
	const parts = Array.isArray(m.content) ? m.content : [];
	const toolLines = parts
		.map((part) => part as { type?: string; name?: string; arguments?: unknown })
		.filter((p) => p?.type === "toolCall")
		.map((p) => `- 🔧 \`${p.name ?? "tool"}\` ${summarizeArgs(p.arguments)}`.trimEnd());
	const heading =
		role === "assistant"
			? "🤖 Assistant"
			: role === "user"
				? "🧑 User"
				: role === "toolResult"
					? "🔧 Tool result"
					: `### ${role}`;
	const body = [text, ...toolLines].filter(Boolean).join("\n\n");
	if (!body) return "";
	return `## ${heading}\n\n${body}\n`;
}

/** Render a tool_execution_end event as one Markdown line. */
export function renderToolMarkdown(event: unknown): string {
	const e = event as { toolName?: string; isError?: boolean; result?: unknown; error?: unknown } | null | undefined;
	if (!e?.toolName) return "";
	const state = e.isError ? "✗" : "✓";
	const error = e.error ? ` — ${String((e.error as { message?: string })?.message ?? e.error).slice(0, 200)}` : "";
	return `- ${state} \`${e.toolName}\`${error}`;
}
