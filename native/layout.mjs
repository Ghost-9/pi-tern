/**
 * Dock split: pi-tui draws the composer/status at the bottom of the grid inside a
 * box (a long horizontal rule). Split the screen there so the transcript area can
 * live in `main` and the composer/status stays pinned in `dock`.
 */
// Anchored on purpose: the earlier form matched any line *containing* eight rule characters, so a
// markdown `----------` or a diff hunk line inside the transcript could be mistaken for the
// composer's box and moved into `dock`.
const RULE = /^[\s\u2500\u2501-]*[\u2500\u2501-]{8,}[\s\u2500\u2501-]*$/;

function isRule(line) {
	return RULE.test(line.replace(/\x1b\[[0-9;]*m/g, ""));
}

/** Returns the index of the composer's lowest rule, or -1 when not found. */
export function findDockStart(lines) {
	for (let row = lines.length - 1; row >= Math.max(0, lines.length - 12); row -= 1) {
		if (isRule(lines[row])) return row;
	}
	return -1;
}

/** Split visible lines into the transcript area and the composer/status dock. */
export function splitDock(lines) {
	const start = findDockStart(lines);
	if (start <= 0) return { main: lines, dock: [] };
	return { main: lines.slice(0, start), dock: lines.slice(start) };
}

/**
 * Split the screen into transcript / composer / status by the composer's two
 * rules. Returns null when the composer box cannot be identified.
 */
export function splitComposer(lines) {
	let close = -1;
	for (let row = lines.length - 1; row >= Math.max(0, lines.length - 14); row -= 1) {
		if (isRule(lines[row])) {
			close = row;
			break;
		}
	}
	if (close <= 0) return null;
	let open = -1;
	for (let row = close - 1; row >= Math.max(0, close - 14); row -= 1) {
		if (isRule(lines[row])) {
			open = row;
			break;
		}
	}
	if (open < 0) return null;
	return { main: lines.slice(0, open), composer: lines.slice(open + 1, close), status: lines.slice(close + 1) };
}
