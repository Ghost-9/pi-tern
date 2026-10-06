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
	/**
	 * Why the launcher's TSP handshake failed, written by `native/pi-tern.mjs`.
	 *
	 * The handshake is a race, and the launcher used to fall back to stock pi silently, so the only
	 * symptom of a lost reply was that native mode sometimes did not engage. `reason` distinguishes
	 * `timeout` (nothing arrived), `unexpected-reply:…` (something arrived but was not a hello —
	 * usually a version mismatch) and `no-raw-mode:…`. Cleared on the next success.
	 */
	probeFailure?: { reason: string; attempts: number; at: number };
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
