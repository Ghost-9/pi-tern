/**
 * Tern daemon relay client.
 *
 * One persistent connection with a request queue: frames are `u32LE length + UTF-8 JSON`.
 * Greet `{"hello":{}}` -> `{"welcome":{}}`; then `{"id":N,"browser":OP}` -> `{"id":N,"browser":ANSWER}`.
 */
import net from "node:net";

export class FrameReader {
	private buffer = Buffer.alloc(0);
	private frames: unknown[] = [];
	private waiters: Array<{ resolve: (v: unknown) => void; reject: (e: Error) => void }> = [];
	private closed: Error | undefined;

	feed(chunk: Buffer): void {
		if (this.closed) return;
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
			if (waiter) waiter.resolve(parsed);
			else this.frames.push(parsed);
		}
	}

	next(timeoutMs: number): Promise<unknown> {
		if (this.frames.length > 0) return Promise.resolve(this.frames.shift());
		if (this.closed) return Promise.reject(this.closed);
		return new Promise((resolve, reject) => {
			const waiter = { resolve, reject };
			const timer = setTimeout(() => {
				const index = this.waiters.indexOf(waiter);
				if (index >= 0) this.waiters.splice(index, 1);
				reject(new Error("relay timeout"));
			}, timeoutMs);
			timer.unref?.();
			waiter.resolve = (value: unknown) => {
				clearTimeout(timer);
				resolve(value);
			};
			waiter.reject = (error: Error) => {
				clearTimeout(timer);
				reject(error);
			};
			this.waiters.push(waiter);
		});
	}

	close(error: Error): void {
		this.closed = this.closed ?? error;
		for (const waiter of this.waiters.splice(0)) waiter.reject(error);
	}
}

export function encodeFrame(obj: unknown): Buffer {
	const body = Buffer.from(JSON.stringify(obj), "utf8");
	const head = Buffer.alloc(4);
	head.writeUInt32LE(body.length, 0);
	return Buffer.concat([head, body]);
}

export class RelayClient {
	private socket: net.Socket | undefined;
	private reader = new FrameReader();
	private connecting: Promise<void> | undefined;
	private nextId = 1;
	private idleTimer: ReturnType<typeof setTimeout> | undefined;
	private pending = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
	>();

	private readonly socketPath: string;

	constructor(socketPath: string) {
		this.socketPath = socketPath;
	}

	get connected(): boolean {
		return this.socket !== undefined && this.socket.destroyed === false;
	}

	private async connect(timeoutMs: number): Promise<void> {
		if (this.connected) return;
		if (this.connecting) return this.connecting;
		this.reader = new FrameReader();
		this.connecting = new Promise<void>((resolve, reject) => {
			const socket = net.connect(this.socketPath);
			const onEarlyError = (error: Error) => reject(error);
			socket.once("error", onEarlyError);
			socket.once("connect", () => {
				socket.off("error", onEarlyError);
				socket.on("error", (error) => this.teardown(error));
				socket.on("close", () => this.teardown(new Error("relay connection closed")));
				socket.on("data", (chunk: Buffer) => {
					try {
						this.reader.feed(chunk);
					} catch (error) {
						this.teardown(error as Error);
					}
				});
				// Ref'd for connect + request; request() unrefs once nothing is pending.
				this.socket = socket;
				socket.write(encodeFrame({ hello: {} }));
				this.reader
					.next(timeoutMs)
					.then(() => {
						void this.pump();
						resolve();
					})
					.catch((error: Error) => {
						this.teardown(error);
						reject(error);
					});
			});
		}).finally(() => {
			this.connecting = undefined;
		});
		return this.connecting;
	}

	private async pump(): Promise<void> {
		for (;;) {
			let frame: unknown;
			try {
				frame = await this.reader.next(24 * 60 * 60 * 1000);
			} catch {
				return;
			}
			const message = frame as { id?: number; browser?: unknown };
			if (typeof message?.id !== "number") continue;
			const waiter = this.pending.get(message.id);
			if (!waiter) continue;
			clearTimeout(waiter.timer);
			this.pending.delete(message.id);
			// The daemon wraps answers: {"id":N,"browser":ANSWER}.
			waiter.resolve(message.browser ?? frame);
		}
	}

	private teardown(error: Error): void {
		this.socket?.destroy();
		this.socket = undefined;
		this.reader.close(error);
		for (const [, waiter] of this.pending) {
			clearTimeout(waiter.timer);
			waiter.reject(error);
		}
		this.pending.clear();
	}

	async request(op: Record<string, unknown>, timeoutMs = 15000): Promise<unknown> {
		await this.connect(timeoutMs);
		const socket = this.socket;
		if (!socket) throw new Error("relay not connected");
		const id = this.nextId++;
		const response = new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error("relay timeout"));
			}, timeoutMs);
			timer.unref?.();
			this.pending.set(id, { resolve, reject, timer });
		});
		socket.ref?.();
		socket.write(encodeFrame({ id, browser: op }));
		try {
			return await response;
		} finally {
			if (this.pending.size === 0) socket.unref?.();
			this.touchIdle();
		}
	}

	/** Close the connection after a quiet period so nothing holds the process open. */
	private touchIdle(idleMs = 30_000): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(() => {
			if (this.pending.size === 0) this.close();
		}, idleMs);
		this.idleTimer.unref?.();
	}

	close(): void {
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
			this.idleTimer = undefined;
		}
		const socket = this.socket;
		this.socket = undefined;
		this.reader.close(new Error("relay client closed"));
		socket?.end();
		socket?.destroy();
	}
}

const clients = new Map<string, RelayClient>();

/** Relay can be disabled with PI_TERN_RELAY=0 (the CLI fallback is then used). */
export function browserRelayAvailable(): boolean {
	return process.env.PI_TERN_RELAY !== "0";
}

/** One browser op over a cached, reconnecting relay connection. */
export async function relayBrowser(
	socketPath: string,
	op: Record<string, unknown>,
	timeoutMs = 15000,
): Promise<unknown> {
	let client = clients.get(socketPath);
	if (!client) {
		client = new RelayClient(socketPath);
		clients.set(socketPath, client);
	}
	try {
		return await client.request(op, timeoutMs);
	} catch (error) {
		client.close();
		clients.delete(socketPath);
		throw error;
	}
}

/** Connect, greet, disconnect: proves the relay works and measures the round trip. */
export async function relayPing(socketPath: string, timeoutMs = 5000): Promise<{ ok: boolean; ms: number; error?: string }> {
	const started = Date.now();
	const client = new RelayClient(socketPath);
	let failure: string | undefined;
	try {
		// The ping used to swallow the error and always report ok, so `/tern diagnose` claimed a
		// healthy relay with PI_TERN_RELAY=0 or a dead socket.
		await client.request({ op: "state", block: 0 }, timeoutMs).then(
			() => undefined,
			(error: unknown) => {
				failure = error instanceof Error ? error.message : String(error);
			},
		);
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
	} finally {
		client.close();
	}
	const ms = Date.now() - started;
	return failure ? { ok: false, ms, error: failure } : { ok: true, ms };
}
