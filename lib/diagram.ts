/**
 * Diagrams through Tern's built-in Mermaid renderer (merman).
 * Writes a Markdown file and opens it in a Tern file block, where Tern
 * renders ```mermaid fences natively. No browser, no external renderer.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { runTern, scratchDir } from "./tern.ts";

export function writeDiagram(source: string, title?: string, pin = false): { path: string; body: string } {
	const text = source.trim();
	if (!text) throw new Error("diagram source is empty");
	const slug =
		(title ?? text)
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 48) || "diagram";
	// A pinned diagram keeps one path, so `tern open` focuses the existing
	// block instead of opening a second copy — an in-place updating diagram.
	const name = pin ? `${slug}-pinned.md` : `${slug}-${Date.now()}.md`;
	const file = path.join(scratchDir(), name);
	const header = title ? `# ${title}\n\n` : "";
	const body = `${header}\`\`\`mermaid\n${text}\n\`\`\`\n`;
	writeFileSync(file, body, "utf8");
	return { path: file, body };
}

export type DiagramPlacement = "split" | "tab" | "preview";

export function placementArgs(placement: DiagramPlacement): string[] {
	switch (placement) {
		case "tab":
			return ["--tab"];
		case "preview":
			return ["--preview"];
		default:
			return ["--split", "right"];
	}
}

export async function openDiagram(
	file: string,
	placement: DiagramPlacement,
	timeoutMs = 20000,
): Promise<{ path: string; placement: DiagramPlacement; output: string }> {
	const result = await runTern(["open", ...placementArgs(placement), file], timeoutMs);
	if (result.code !== 0 || result.timedOut) {
		throw new Error(
			result.timedOut
				? "tern open timed out"
				: result.stderr.trim() || result.stdout.trim() || `tern open exited ${result.code}`,
		);
	}
	return { path: file, placement, output: result.stdout.trim() };
}
