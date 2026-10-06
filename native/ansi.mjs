/**
 * Minimal ANSI screen model: enough of the escape protocol for pi-tui's frames
 * (cursor moves, erases, SGR) to reconstruct the visible grid as `rows` lines.
 * Pure; unit-tested in test/native.test.ts.
 */

const DEFAULT_STYLE = "";

export class Screen {
	constructor(cols = 80, rows = 24) {
		this.cols = Math.max(1, cols | 0);
		this.rows = Math.max(1, rows | 0);
		this.grid = Array.from({ length: this.rows }, () => Array.from({ length: this.cols }, () => ({ ch: " ", style: DEFAULT_STYLE })));
		this.cursor = { row: 0, col: 0 };
		this.style = DEFAULT_STYLE;
		this.state = "text";
		this.csi = "";
		this.osc = "";
	}

	/** Apply raw terminal output to the grid. */
	write(data) {
		for (const ch of String(data)) {
			this.#char(ch);
		}
	}

	#char(ch) {
		if (this.state === "esc") {
			if (ch === "[") {
				this.state = "csi";
				this.csi = "";
			} else if (ch === "]") {
				this.state = "osc";
				this.osc = "";
			} else {
				this.state = "text";
			}
			return;
		}
		if (this.state === "csi") {
			if (ch >= "\x40" && ch <= "\x7e") {
				this.#csi(this.csi, ch);
				this.state = "text";
			} else {
				this.csi += ch;
			}
			return;
		}
		if (this.state === "osc") {
			if (ch === "\x07") this.state = "text";
			else if (ch === "\x1b") this.state = "osc-esc";
			return;
		}
		if (this.state === "osc-esc") {
			// ST terminator is ESC \; anything else stays in the OSC string.
			this.state = ch === "\\" ? "text" : "osc";
			return;
		}
		if (ch === "\x1b") {
			this.state = "esc";
			return;
		}
		if (ch === "\r") {
			this.cursor.col = 0;
			return;
		}
		if (ch === "\n") {
			this.#advanceRow();
			return;
		}
		if (ch === "\b") {
			this.cursor.col = Math.max(0, this.cursor.col - 1);
			return;
		}
		if (ch === "\t") {
			const next = Math.min(this.cols - 1, (Math.floor(this.cursor.col / 8) + 1) * 8);
			while (this.cursor.col < next) this.#put(" ");
			return;
		}
		this.#put(ch);
	}

	#put(ch) {
		if (this.cursor.row >= this.rows) this.#scroll();
		const cell = this.grid[this.cursor.row]?.[this.cursor.col];
		if (cell) {
			cell.ch = ch;
			cell.style = this.style;
		}
		this.cursor.col = Math.min(this.cols, this.cursor.col + 1);
	}

	#advanceRow() {
		this.cursor.row += 1;
		if (this.cursor.row >= this.rows) this.#scroll();
	}

	#scroll() {
		this.grid.shift();
		this.grid.push(Array.from({ length: this.cols }, () => ({ ch: " ", style: DEFAULT_STYLE })));
		this.cursor.row = this.rows - 1;
	}

	#csi(params, final) {
		const p = params.replace(/^[?>!]/, "").split(";").map((value) => (value === "" ? undefined : Number(value)));
		const n = p[0];
		switch (final) {
			case "H":
			case "f":
				this.cursor.row = Math.max(0, Math.min(this.rows - 1, (p[0] ?? 1) - 1));
				this.cursor.col = Math.max(0, Math.min(this.cols - 1, (p[1] ?? 1) - 1));
				break;
			case "A":
				this.cursor.row = Math.max(0, this.cursor.row - (n || 1));
				break;
			case "B":
				this.cursor.row = Math.min(this.rows - 1, this.cursor.row + (n || 1));
				break;
			case "C":
				this.cursor.col = Math.min(this.cols, this.cursor.col + (n || 1));
				break;
			case "D":
				this.cursor.col = Math.max(0, this.cursor.col - (n || 1));
				break;
			case "G":
				this.cursor.col = Math.max(0, Math.min(this.cols - 1, (n || 1) - 1));
				break;
			case "d":
				this.cursor.row = Math.max(0, Math.min(this.rows - 1, (n || 1) - 1));
				break;
			case "J":
				this.#eraseDisplay(n ?? 0);
				break;
			case "K":
				this.#eraseLine(n ?? 0);
				break;
			case "m":
				this.style = params ? `\x1b[${params}m` : "";
				break;
			default:
				break;
		}
	}

	#eraseLine(mode) {
		const start = mode === 1 ? 0 : this.cursor.col;
		const end = mode === 1 ? this.cursor.col : this.cols - 1;
		for (let c = start; c <= end; c += 1) {
			const cell = this.grid[this.cursor.row]?.[c];
			if (cell) {
				cell.ch = " ";
				cell.style = DEFAULT_STYLE;
			}
		}
	}

	#eraseDisplay(mode) {
		if (mode === 2 || mode === 3) {
			for (let r = 0; r < this.rows; r += 1) {
				for (let c = 0; c < this.cols; c += 1) {
					this.grid[r][c] = { ch: " ", style: DEFAULT_STYLE };
				}
			}
			if (mode === 2) this.cursor = { row: 0, col: 0 };
			return;
		}
		for (let r = 0; r < this.cursor.row; r += 1) {
			for (let c = 0; c < this.cols; c += 1) this.grid[r][c] = { ch: " ", style: DEFAULT_STYLE };
		}
		this.#eraseLine(1);
	}

	/** Visible rows with SGR runs re-emitted, trailing blanks trimmed. */
	lines() {
		const out = [];
		for (const row of this.grid) {
			let line = "";
			let style = DEFAULT_STYLE;
			let end = row.length;
			while (end > 0 && row[end - 1].ch === " " && row[end - 1].style === DEFAULT_STYLE) end -= 1;
			for (let c = 0; c < end; c += 1) {
				const cell = row[c];
				if (cell.style !== style) {
					line += cell.style === "" ? "\x1b[0m" : cell.style;
					style = cell.style;
				}
				line += cell.ch;
			}
			if (style !== DEFAULT_STYLE) line += "\x1b[0m";
			out.push(line);
		}
		return out;
	}
}
