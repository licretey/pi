import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

/** 帧类型（参见 docs/protocol.md）。 */
const REQUEST = 1;
const RESULT = 2;
const ERROR = 3;
const EVENT = 4;
const CANCEL = 5;
const PING = 6;

const MAX_FRAME = 16 * 1024 * 1024;
const PING_INTERVAL_MS = 5000;
/** 守护进程每五秒发送一次心跳；超过此时长没有消息即视为连接已断开。 */
const SILENCE_LIMIT_MS = 30_000;
/** 启动守护进程并等待其发送 `hello` 消息的最长时长。 */
const START_TIMEOUT_MS = 60_000;

export type Json = Record<string, unknown>;

/** 守护进程报告的失败，包含 Node 风格的错误代码。 */
export class RemoteError extends Error {
	readonly code: string;
	readonly path?: string;
	readonly fields: Json;

	constructor(fields: Json) {
		super(typeof fields.message === "string" ? fields.message : "Remote operation failed");
		this.name = "RemoteError";
		this.code = typeof fields.code === "string" ? fields.code : "unknown";
		if (typeof fields.path === "string") this.path = fields.path;
		this.fields = fields;
	}
}

/** `hello` 消息报告的远程机器信息。 */
export interface RemoteInfo {
	protocol: number;
	version: string;
	os: string;
	arch: string;
	home: string;
	tmpdir: string;
	/** 路径分隔符：`/`；Windows 上为 `\\`。 */
	separator: string;
	/** 守护进程的工作目录；Node 的 `path.resolve` 会以此作为 `process.cwd()` 的回退值。 */
	cwd: string;
	/** Windows 各驱动器的工作目录（如 `C:` → `C:\\work`），取自 `=C:` 等环境变量。 */
	driveCwds: Record<string, string>;
	pid: number;
}

export interface ConnectionOptions {
	/**
	 * 启动守护进程的命令，不包含后续的 `serve --token <hex>` 参数，例如 `["ssh", "-T", "--", "host",
	 * "~/.pi/mobile/tools/pi-env"]`。也可以传入函数，在每次启动时计算命令（例如先检测并部署）；
	 * 函数失败会导致本次启动失败，后续请求会重试。
	 */
	command: readonly string[] | (() => Promise<readonly string[]>);
	/** 接收守护进程和传输层的诊断输出。 */
	onLog?: (text: string) => void;
}

export interface Reply {
	json: Json;
	payload: Uint8Array;
	/** 响应请求的守护进程会话；该会话存续期间，其句柄才有效。 */
	session: number;
}

type Pending = {
	resolve: (value: Reply) => void;
	reject: (error: Error) => void;
	onEvent?: (json: Json, payload: Uint8Array) => void;
};

export interface RequestOptions {
	payload?: Uint8Array;
	/** 中止时发送 `cancel`；请求仍会以守护进程返回的结果或错误结束。 */
	signal?: AbortSignal;
	/** 此请求的进度事件，例如 `exec` 输出。 */
	onEvent?: (json: Json, payload: Uint8Array) => void;
	/** 供 `kill` 使用的请求 ID 和会话。 */
	onStart?: (id: number, session: number) => void;
	/**
	 * 仅在此守护进程会话中执行，并且只用于该会话打开的句柄。连接断开并重新启动后，此类请求会直接失败，
	 * 不会发送给从未打开该句柄的新守护进程。
	 */
	session?: number;
}

/** Node 为系统调用编码字符串时，会将孤立代理项替换为 U+FFFD。 */
function wellFormed(_key: string, value: unknown): unknown {
	return typeof value === "string" ? value.toWellFormed() : value;
}

function frame(type: number, id: number, json: Json, payload: Uint8Array = new Uint8Array(0)): Buffer {
	const body = Buffer.from(JSON.stringify(json, wellFormed), "utf8");
	const header = Buffer.alloc(13);
	header.writeUInt32BE(9 + body.length + payload.length, 0);
	header.writeUInt8(type, 4);
	header.writeUInt32BE(id, 5);
	header.writeUInt32BE(body.length, 9);
	return Buffer.concat([header, body, payload]);
}

/** 连接失败或已结束；重新建立连接后，请求可能成功。 */
function lost(message: string): RemoteError {
	return new RemoteError({ code: "unknown", message, lost: true });
}

/** 判断错误是否表示连接已断开，而不是守护进程拒绝了请求。 */
export function isConnectionLost(error: unknown): boolean {
	return error instanceof RemoteError && error.fields.lost === true;
}

function closed(): RemoteError {
	return new RemoteError({ code: "unknown", message: "Connection closed" });
}

/** 一个正在运行的守护进程。 */
class Session {
	readonly id: number;
	readonly child: ChildProcessWithoutNullStreams;
	readonly token: string;
	readonly pending = new Map<number, Pending>();
	/** 已接收但尚未解析的字节；避免每次收到数据块时都进行拼接。 */
	chunks: Buffer[] = [];
	buffered = 0;
	synced = false;
	lastSeen = Date.now();
	timer: ReturnType<typeof setInterval> | undefined;
	live = true;

	constructor(id: number, child: ChildProcessWithoutNullStreams, token: string) {
		this.id = id;
		this.child = child;
		this.token = token;
	}

	/** 将缓冲区开头的 `length` 个字节作为单个缓冲区返回，但不移除这些字节。 */
	peek(length: number): Buffer {
		if (this.chunks[0]!.length < length) {
			this.chunks = [Buffer.concat(this.chunks)];
		}
		return this.chunks[0]!.subarray(0, length);
	}

	consume(length: number): void {
		this.buffered -= length;
		while (length > 0) {
			const first = this.chunks[0]!;
			if (first.length <= length) {
				this.chunks.shift();
				length -= first.length;
			} else {
				this.chunks[0] = first.subarray(length);
				length = 0;
			}
		}
	}
}

/**
 * 到 pi-env 守护进程的单个连接：首次收到请求时才启动，断开后会重新启动。连接断开时仍在进行的请求会以
 * `unknown` 错误码失败；对于变更操作，其执行结果也无法确定。
 */
export class Connection {
	readonly #options: ConnectionOptions;
	#session: Session | undefined;
	#ready: Promise<{ info: RemoteInfo; session: Session }> | undefined;
	#sessions = 0;
	#nextId = 1;
	#closed = false;

	constructor(options: ConnectionOptions) {
		this.#options = options;
	}

	/** 必要时建立连接，并返回守护进程报告的机器信息。 */
	async info(): Promise<RemoteInfo> {
		return (await this.#connect()).info;
	}

	/** 必要时建立连接，并返回当前活动会话的 ID。 */
	async session(): Promise<number> {
		return (await this.#connect()).session.id;
	}

	async request(op: string, json: Json, options: RequestOptions = {}): Promise<Reply> {
		if (options.session !== undefined) {
			const current = this.#session;
			if (current === undefined || current.id !== options.session || !current.live) {
				throw lost("pi-env connection lost");
			}
			return this.#send(current, op, json, options);
		}
		const { session } = await this.#connect();
		return this.#send(session, op, json, options);
	}

	/** 停止守护进程；它会终止自己启动的所有进程。 */
	close(): void {
		this.#closed = true;
		if (this.#session) this.#teardown(this.#session, closed());
	}

	/** 终止一项 `exec` 操作，但不将其标记为中止。 */
	kill(id: number, session: number): void {
		const current = this.#session;
		if (current?.id === session && current.live) this.#write(current, frame(CANCEL, id, { mode: "kill" }));
	}

	#connect(): Promise<{ info: RemoteInfo; session: Session }> {
		if (this.#closed) return Promise.reject(closed());
		if (this.#ready === undefined) {
			const ready = this.#start();
			this.#ready = ready;
			// 不会记住启动失败；下一个请求会重新尝试。
			ready.catch(() => {
				if (this.#ready === ready) this.#ready = undefined;
			});
		}
		return this.#ready;
	}

	#send(session: Session, op: string, json: Json, options: RequestOptions): Promise<Reply> {
		if (!session.live) return Promise.reject(lost("pi-env connection lost"));
		const id = this.#nextId++;
		return new Promise((resolve, reject) => {
			const onAbort = () => this.#write(session, frame(CANCEL, id, {}));
			const done = () => options.signal?.removeEventListener("abort", onAbort);
			session.pending.set(id, {
				resolve: (value) => {
					done();
					resolve(value);
				},
				reject: (error) => {
					done();
					reject(error);
				},
				...(options.onEvent ? { onEvent: options.onEvent } : {}),
			});
			options.signal?.addEventListener("abort", onAbort, { once: true });
			options.onStart?.(id, session.id);
			this.#write(session, frame(REQUEST, id, { ...json, op }, options.payload));
			if (options.signal?.aborted) onAbort();
		});
	}

	#write(session: Session, data: Buffer): void {
		if (session.live) session.child.stdin.write(data);
	}

	async #start(): Promise<{ info: RemoteInfo; session: Session }> {
		let command: readonly string[];
		try {
			const option = this.#options.command;
			command = typeof option === "function" ? await option() : option;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new RemoteError({ code: "spawn_error", message, lost: true });
		}
		if (this.#closed) throw closed();
		const [program, ...args] = command;
		if (program === undefined) throw new RemoteError({ code: "spawn_error", message: "No daemon command" });
		const token = randomBytes(16).toString("hex");
		const child = spawn(program, [...args, "serve", "--token", token], { stdio: ["pipe", "pipe", "pipe"] });
		const session = new Session(++this.#sessions, child, token);
		this.#session = session;
		let startTimer: ReturnType<typeof setTimeout> | undefined;
		const failed = new Promise<never>((_resolve, reject) => {
			startTimer = setTimeout(
				() => reject(lost(`pi-env did not answer within ${START_TIMEOUT_MS / 1000} s`)),
				START_TIMEOUT_MS,
			);
			child.once("error", (error) =>
				reject(new RemoteError({ code: "spawn_error", message: error.message, lost: true })),
			);
			child.once("exit", (code) => reject(lost(`pi-env exited with code ${code} before it was ready`)));
		});
		failed.catch(() => {});
		child.stdout.on("data", (chunk: Buffer) => this.#onData(session, chunk));
		child.stderr.on("data", (chunk: Buffer) => this.#options.onLog?.(chunk.toString("utf8")));
		child.on("error", () => this.#teardown(session, lost("pi-env connection lost")));
		child.on("exit", () => this.#teardown(session, lost("pi-env connection lost")));
		child.stdin.on("error", () => {});
		session.timer = setInterval(() => {
			this.#write(session, frame(PING, 0, {}));
			if (Date.now() - session.lastSeen > SILENCE_LIMIT_MS) {
				this.#teardown(session, lost("pi-env connection timed out"));
			}
		}, PING_INTERVAL_MS);
		session.timer.unref();
		try {
			const { json } = await Promise.race([this.#send(session, "hello", { protocol: 1 }, {}), failed]);
			if (json.protocol !== 1) throw lost(`Unsupported protocol ${json.protocol}`);
			return { info: json as unknown as RemoteInfo, session };
		} catch (error) {
			this.#teardown(session, error instanceof Error ? error : lost(String(error)));
			throw error;
		} finally {
			clearTimeout(startTimer);
		}
	}

	#teardown(session: Session, error: Error): void {
		if (!session.live) return;
		session.live = false;
		clearInterval(session.timer);
		if (this.#session === session) {
			this.#session = undefined;
			this.#ready = undefined;
		}
		session.child.stdin.end();
		session.child.kill();
		const pending = [...session.pending.values()];
		session.pending.clear();
		for (const request of pending) request.reject(error);
	}

	#onData(session: Session, chunk: Buffer): void {
		if (!session.live) return;
		session.lastSeen = Date.now();
		session.chunks.push(chunk);
		session.buffered += chunk.length;
		if (!session.synced) {
			// shell 启动文件可能会在守护进程运行前输出内容；跳过同步标记行之前的所有输出。
			const marker = Buffer.from(`PI-ENV ${session.token}\n`, "utf8");
			const all = session.peek(session.buffered);
			const index = all.indexOf(marker);
			if (index === -1) {
				if (session.buffered > 1024 * 1024) {
					session.consume(session.buffered - marker.length);
				}
				return;
			}
			const noise = all.subarray(0, index).toString("utf8").trim();
			if (noise !== "") this.#options.onLog?.(noise);
			session.consume(index + marker.length);
			session.synced = true;
		}
		while (session.live && session.buffered >= 4) {
			const length = session.peek(4).readUInt32BE(0);
			if (length < 9 || length > MAX_FRAME) {
				this.#teardown(session, lost("Corrupt frame from pi-env"));
				return;
			}
			if (session.buffered < 4 + length) return;
			const body = session.peek(4 + length).subarray(4);
			const type = body.readUInt8(0);
			const id = body.readUInt32BE(1);
			const jsonLength = body.readUInt32BE(5);
			let json: Json;
			try {
				if (9 + jsonLength > length) throw new Error("JSON length out of range");
				const parsed: unknown = JSON.parse(body.subarray(9, 9 + jsonLength).toString("utf8"));
				if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
					throw new Error("not an object");
				json = parsed as Json;
			} catch {
				this.#teardown(session, lost("Corrupt frame from pi-env"));
				return;
			}
			// 创建普通 Uint8Array 副本，与 `NodeExecutionEnv` 的读取结果一致；不能使用接收缓冲区的视图。
			const payload = new Uint8Array(body.subarray(9 + jsonLength));
			session.consume(4 + length);
			this.#dispatch(session, type, id, json, payload);
		}
	}

	#dispatch(session: Session, type: number, id: number, json: Json, payload: Uint8Array): void {
		const pending = session.pending.get(id);
		if (type === EVENT) {
			pending?.onEvent?.(json, payload);
			return;
		}
		if (type !== RESULT && type !== ERROR) return;
		if (pending === undefined) return;
		session.pending.delete(id);
		if (type === RESULT) pending.resolve({ json, payload, session: session.id });
		else pending.reject(new RemoteError(json));
	}
}
