/**
 * Dock split: pi-tui draws the composer/status at the bottom of the grid inside a
 * box (a long horizontal rule). Split the screen there so the transcript area can
 * live in `main` and the composer/status stays pinned in `dock`.
 */
const RULE = /^[\s\u2500\u2501-]*[\u2500\u2501-]{8,}/;

/** Returns the index of the composer's top border, or -1 when not found. */
export function findDockStart(lines) {
	for (let row = lines.length - 1; row >= Math.max(0, lines.length - 12); row -= 1) {
		const text = lines[row].replace(/\x1b\[[0-9;]*m/g, "");
		if (RULE.test(text)) return row;
	}
	return -1;
}

/** Split visible lines into the transcript area and the composer/status dock. */
export function splitDock(lines) {
	const start = findDockStart(lines);
	if (start <= 0) return { main: lines, dock: [] };
	return { main: lines.slice(0, start), dock: lines.slice(start) };
}
