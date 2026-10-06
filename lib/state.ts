/**
 * Small persisted state (mirror preference, last pinned diagram, control endpoint)
 * so a session can restore itself after a Tern window or pi restart.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { scratchDir } from "./tern.ts";

export interface PiTernState {
	mirror?: { enabled: boolean };
	lastDiagram?: string;
	control?: string;
	/** Remembered Tern block kind for a pane, so the native-surface check costs nothing on restart. */
	paneKind?: { pane: string; kind: string; at: number };
	/** When the "this is a terminal block" explanation was last shown, so it is said once, not per pane. */
	blockNotice?: { kind: string; at: number };
}

export function stateFile(): string {
	return path.join(scratchDir(), "state.json");
}

export function loadState(): PiTernState {
	try {
		const parsed = JSON.parse(readFileSync(stateFile(), "utf8")) as PiTernState;
		return typeof parsed === "object" && parsed !== null ? parsed : {};
	} catch {
		return {};
	}
}

export function saveState(patch: Partial<PiTernState>): PiTernState {
	const next = { ...loadState(), ...patch };
	try {
		writeFileSync(stateFile(), `${JSON.stringify(next, null, 2)}\n`, "utf8");
	} catch {
		/* best effort */
	}
	return next;
}
