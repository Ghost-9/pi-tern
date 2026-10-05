/**
 * Tern daemon relay client — the channel omp uses for its Tern browser PiP.
 * Unix socket at $TERN_PANE_SOCKET, frames = u32LE length + UTF-8 JSON.
 * Greet {"hello":{}} -> {"welcome":{}}; then {"id":N,"browser":OP} -> {"id":N,"browser":ANSWER}.
 */
import net from "node:net";

export class FrameReader {
	private buffer = Buffer.alloc(0);
	private frames: unknown[] = [];
	private waiters: Array<(v: unknown) => void> = [];

	feed(chunk: Buffer): void {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		for (;;) {
			if (this.buffer.length < 4) return;
			const size = this.buffer.readUInt32LE(0);
			if (size > 64 * 1024 * 1024) throw new Error(`relay frame too large: ${size}`);
			if (this.buffer.length < 4 + size) return;
			const body = this.buffer.subarray(4, 4 + size);
			this.buffer = this.buffer.subarray(4 + size);
			let parsed: unknown;
			try {
				parsed = JSON.parse(body.toString("utf8"));
			} catch {
				continue;
			}
			const waiter = this.waiters.shift();
			if (waiter) waiter(parsed);
			else this.frames.push(parsed);
		}
	}

	next(timeoutMs: number): Promise<unknown> {
		if (this.frames.length > 0) return Promise.resolve(this.frames.shift());
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				const i = this.waiters.indexOf(waiter);
				if (i >= 0) this.waiters.splice(i, 1);
				reject(new Error("relay timeout"));
			}, timeoutMs);
			const waiter = (v: unknown) => {
				clearTimeout(timer);
				resolve(v);
			};
			this.waiters.push(waiter);
		});
	}
}

export function encodeFrame(obj: unknown): Buffer {
	const body = Buffer.from(JSON.stringify(obj), "utf8");
	const head = Buffer.alloc(4);
	head.writeUInt32LE(body.length, 0);
	return Buffer.concat([head, body]);
}

/** Relay can be disabled with PI_TERN_RELAY=0 (the CLI fallback is then used). */
export function browserRelayAvailable(): boolean {
	return process.env.PI_TERN_RELAY !== "0";
}

/**
 * One relay round trip: connect, greet, send one browser op, read its answer.
 * The answer is the raw JSON the daemon returns ({"ok":…} or {"error":…}).
 */
export async function relayBrowser(
	socketPath: string,
	op: Record<string, unknown>,
	timeoutMs = 15000,
): Promise<unknown> {
	const socket = net.connect(socketPath);
	const reader = new FrameReader();
	socket.on("data", (chunk: Buffer) => {
		try {
			reader.feed(chunk);
		} catch {
			socket.destroy();
		}
	});
	await new Promise<void>((resolve, reject) => {
		socket.once("connect", () => resolve());
		socket.once("error", reject);
	});
	try {
		socket.write(encodeFrame({ hello: {} }));
		await reader.next(timeoutMs);
		socket.write(encodeFrame({ id: 1, browser: op }));
		const frame = (await reader.next(timeoutMs)) as { browser?: unknown } | null;
		// The daemon answers {"id":N,"browser":ANSWER}; unwrap it.
		return frame && typeof frame === "object" && "browser" in frame ? frame.browser : frame;
	} finally {
		socket.end();
		socket.destroy();
	}
}
