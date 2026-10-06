/**
 * `tern events` stream: JSON lines of daemon events (pane_exited, pane_spawned, …).
 */
import { spawn, type ChildProcess } from "node:child_process";

export type TernEvent = Record<string, unknown>;

export function parseEventLine(line: string): TernEvent | null {
	const trimmed = line.trim();
	if (!trimmed.startsWith("{")) return null;
	try {
		const parsed = JSON.parse(trimmed) as unknown;
		return typeof parsed === "object" && parsed !== null ? (parsed as TernEvent) : null;
	} catch {
		return null;
	}
}

/** Event name: Tern uses `event` (falling back to kind/type for safety). */
export function eventName(event: TernEvent): string {
	const name = event.event ?? event.kind ?? event.type;
	return typeof name === "string" ? name : "unknown";
}

export interface TernEventStreamOptions {
	filter?: string[];
	onError?: (error: Error) => void;
}

export class TernEventStream {
	private child: ChildProcess | undefined;
	private buffer = "";
	private listeners = new Set<(event: TernEvent) => void>();
	private lastError: Error | undefined;

	private readonly options: TernEventStreamOptions;

	constructor(options: TernEventStreamOptions = {}) {
		this.options = options;
	}

	start(): void {
		if (this.child) return;
		const args = ["events"];
		if (this.options.filter?.length) args.push("--filter", this.options.filter.join(","));
		const child = spawn("tern", args, { stdio: ["ignore", "pipe", "pipe"] });
		this.child = child;
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => this.feed(chunk));
		// Drain stderr: an unread pipe fills at 64 KB and stalls the child until the timeout.
		child.stderr?.resume();
		child.on("error", (error) => {
			this.lastError = error as Error;
			this.child = undefined;
			this.options.onError?.(error as Error);
		});
		child.on("exit", () => {
			this.child = undefined;
		});
	}

	private feed(chunk: string): void {
		this.buffer += chunk;
		for (;;) {
			const index = this.buffer.indexOf("\n");
			if (index < 0) break;
			const line = this.buffer.slice(0, index);
			this.buffer = this.buffer.slice(index + 1);
			const event = parseEventLine(line);
			if (!event) continue;
			for (const listener of this.listeners) listener(event);
		}
	}

	on(listener: (event: TernEvent) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	get running(): boolean {
		return this.child !== undefined;
	}

	get error(): Error | undefined {
		return this.lastError;
	}

	stop(): void {
		const child = this.child;
		this.child = undefined;
		this.buffer = "";
		this.listeners.clear();
		if (child) child.kill();
	}
}

/** Resolve with the first matching event, or `timedOut` after the deadline. */
export function waitForEvent(options: {
	filter?: string[];
	match: (event: TernEvent) => boolean;
	timeoutMs: number;
}): Promise<{ event: TernEvent | null; timedOut: boolean }> {
	return new Promise((resolve) => {
		const stream = new TernEventStream({ filter: options.filter });
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let unsubscribe: (() => void) | undefined;
		const finish = (event: TernEvent | null, timedOut: boolean) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			unsubscribe?.();
			stream.stop();
			resolve({ event, timedOut });
		};
		unsubscribe = stream.on((event) => {
			if (options.match(event)) finish(event, false);
		});
		timer = setTimeout(() => finish(null, true), options.timeoutMs);
		stream.start();
	});
}
