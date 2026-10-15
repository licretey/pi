import { Worker } from "node:worker_threads";
import { toCodemodeIdentifier } from "../identifier.ts";
import type {
	CodemodeCall,
	CodemodeCallStatus,
	CodemodeError,
	CodemodeExecuteOptions,
	CodemodeOutputItem,
	CodemodeResult,
	CodemodeSandboxOptions,
	CodemodeStoreWrites,
	CodemodeTool,
} from "../types.ts";
import { type CodemodeWasmModule, loadQuickJSWasm } from "../wasm.ts";
import {
	type HostToWorkerMessage,
	isWorkerToHostMessage,
	type WorkerData,
	type WorkerToHostMessage,
} from "./protocol.ts";

const DEFAULT_TIMEOUT_MS = 300_000;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const RESERVED_GLOBALS: ReadonlySet<string> = new Set([
	"tools",
	"ALL_TOOLS",
	"console",
	"text",
	"image",
	"exit",
	"globalThis",
	"store",
	"load",
]);

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function serializeStore(store: Readonly<Record<string, unknown>> | undefined): Record<string, string> {
	const serialized: Record<string, string> = {};
	for (const [key, value] of Object.entries(store ?? {})) {
		const json = JSON.stringify(value);
		if (json !== undefined) serialized[key] = json;
	}
	return serialized;
}

/**
 * 为宿主序列化值的 prelude 与脚本运行在同一个虚拟机中，因此脚本修改内置对象
 *（例如 `Array.prototype.toJSON`）可能导致其发送格式错误的数据。
 * 无法解码的负载会抛出此错误，并导致执行以沙箱错误结束。
 */
class BridgeError extends Error {}

function parseBridgeJson(json: string, what: string): unknown {
	try {
		return JSON.parse(json);
	} catch {
		throw new BridgeError(`${what} is not valid JSON`);
	}
}

function parseStoreWrites(json: string): CodemodeStoreWrites {
	const entries = parseBridgeJson(json, "store writes");
	if (!Array.isArray(entries)) throw new BridgeError("store writes are not an array");
	const writes: CodemodeStoreWrites = { set: {}, delete: [] };
	for (const entry of entries) {
		if (
			!Array.isArray(entry) ||
			typeof entry[0] !== "string" ||
			(entry.length === 2 ? typeof entry[1] !== "string" : entry.length !== 1)
		) {
			throw new BridgeError("store writes contain a malformed entry");
		}
		const [key, value] = entry as [string, string?];
		if (value === undefined) writes.delete.push(key);
		else writes.set[key] = parseBridgeJson(value, `store value for ${JSON.stringify(key)}`);
	}
	return writes;
}

function parseScriptError(json: string): CodemodeError {
	const parsed = parseBridgeJson(json, "script error");
	if (typeof parsed !== "object" || parsed === null) throw new BridgeError("script error is not an object");
	const { name, message, stack } = parsed as Record<string, unknown>;
	if (
		typeof message !== "string" ||
		(name !== undefined && typeof name !== "string") ||
		(stack !== undefined && typeof stack !== "string")
	) {
		throw new BridgeError("script error is malformed");
	}
	return { kind: "script", name, message, stack };
}

function defaultWorkerUrl(): URL {
	// 从源码运行（测试、tsx）时使用 `.ts`；从已发布的 dist 运行时使用 `.js`。
	return new URL(import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js", import.meta.url);
}

interface PendingCall {
	record: CodemodeCall | undefined;
	startedAt: number;
	controller: AbortController;
}

interface ExecutionOptions {
	code: string;
	tools: ReadonlyMap<string, CodemodeTool>;
	globals: ReadonlyMap<string, CodemodeTool>;
	timeoutMs: number;
	signal: AbortSignal | undefined;
	memoryLimitBytes: number | undefined;
	store: Record<string, string>;
	wasm: Promise<CodemodeWasmModule>;
	workerUrl: string | URL;
}

/**
 * 每个脚本都在独立的工作线程和 QuickJS 虚拟机中运行。每次运行都创建新的工作线程，
 * 让终止操作保持简单：失控脚本（包括只循环处理微任务队列的脚本）会通过 `terminate()` 被杀死，
 * 不会影响之后的运行。
 */
class Execution {
	readonly promise: Promise<CodemodeResult>;
	private resolveResult!: (result: CodemodeResult) => void;
	private worker: Worker | undefined;
	private readonly interrupt = new SharedArrayBuffer(4);
	private readonly tools: ReadonlyMap<string, CodemodeTool>;
	private readonly globals: ReadonlyMap<string, CodemodeTool>;
	private readonly signal: AbortSignal | undefined;
	private readonly timer: NodeJS.Timeout | undefined;
	private readonly output: CodemodeOutputItem[] = [];
	private readonly calls: CodemodeCall[] = [];
	private readonly pending = new Map<number, PendingCall>();
	private finished = false;

	constructor(options: ExecutionOptions) {
		this.promise = new Promise<CodemodeResult>((resolve) => {
			this.resolveResult = resolve;
		});
		this.tools = options.tools;
		this.globals = options.globals;
		this.signal = options.signal;

		if (Number.isFinite(options.timeoutMs)) {
			this.timer = setTimeout(() => {
				this.finish({ kind: "timeout", message: `Execution timed out after ${options.timeoutMs} ms` });
			}, options.timeoutMs);
		}

		if (options.signal) {
			if (options.signal.aborted) {
				this.onAbort();
			} else {
				options.signal.addEventListener("abort", this.onAbort, { once: true });
			}
		}

		options.wasm.then(
			(wasm) => this.start(options, wasm),
			(error: unknown) => {
				this.finish({ kind: "sandbox", message: `Failed to load QuickJS: ${errorMessage(error)}` });
			},
		);
	}

	abort(message: string): Promise<CodemodeResult> {
		this.finish({ kind: "aborted", message });
		return this.promise;
	}

	private start(options: ExecutionOptions, wasm: CodemodeWasmModule): void {
		if (this.finished) return;
		const workerData: WorkerData = {
			code: options.code,
			tools: [...options.tools.values()].map((tool) => ({
				name: tool.name,
				jsName: toCodemodeIdentifier(tool.name),
				description: tool.description ?? "",
			})),
			globals: [...options.globals.values()].map((global) => ({
				name: global.name,
				spread: global.spread === true,
			})),
			wasm,
			memoryLimitBytes: options.memoryLimitBytes,
			store: options.store,
			interrupt: this.interrupt,
		};
		let worker: Worker;
		try {
			worker = new Worker(options.workerUrl, { workerData });
		} catch (error) {
			this.finish({ kind: "sandbox", message: `Failed to start worker: ${errorMessage(error)}` });
			return;
		}
		this.worker = worker;
		worker.on("message", (message: unknown) => {
			// 此处若抛出异常，会成为宿主进程中的未捕获异常，并导致执行一直无法结束。
			try {
				this.handleMessage(message);
			} catch (error) {
				this.finish({
					kind: "sandbox",
					message:
						error instanceof BridgeError
							? `Sandbox bridge broken: ${error.message}. The script may have modified built-ins such as a prototype's toJSON.`
							: `Sandbox host failed: ${errorMessage(error)}`,
				});
			}
		});
		worker.on("error", (error: unknown) => {
			this.finish({
				kind: "sandbox",
				name: error instanceof Error ? error.name : undefined,
				message: errorMessage(error),
			});
		});
		worker.on("exit", (code) => {
			this.finish({ kind: "sandbox", message: `Worker exited with code ${code} before the script settled` });
		});
	}

	private readonly onAbort = (): void => {
		const reason: unknown = this.signal?.reason;
		this.finish({ kind: "aborted", message: reason instanceof Error ? reason.message : "Execution aborted" });
	};

	private post(message: HostToWorkerMessage): void {
		this.worker?.postMessage(message);
	}

	private handleMessage(message: unknown): void {
		if (this.finished) return;
		if (!isWorkerToHostMessage(message)) throw new BridgeError("unknown message from the worker");
		switch (message.type) {
			case "output":
				this.output.push(message.item);
				break;
			case "call":
				if (this.pending.has(message.id)) throw new BridgeError(`duplicate call id ${message.id}`);
				void this.handleCall(message);
				break;
			case "done":
				this.handleDone(message);
				break;
			case "crash":
				this.finish({ kind: "sandbox", message: message.message });
				break;
		}
	}

	private handleDone(message: Extract<WorkerToHostMessage, { type: "done" }>): void {
		// 在调用 finish() 前解码所有内容；finish() 一旦开始就不能再抛出异常。
		if (!message.ok) {
			this.finish(parseScriptError(message.error));
			return;
		}
		const value = message.value === undefined ? undefined : parseBridgeJson(message.value, "return value");
		this.finish(undefined, value, parseStoreWrites(message.writes));
	}

	private async handleCall(message: Extract<WorkerToHostMessage, { type: "call" }>): Promise<void> {
		const { id, name } = message;
		const isTool = message.target === "tool";
		const record: CodemodeCall | undefined = isTool ? { name, status: "cancelled", durationMs: 0 } : undefined;
		if (record) this.calls.push(record);
		const pending: PendingCall = { record, startedAt: performance.now(), controller: new AbortController() };
		this.pending.set(id, pending);

		let status: CodemodeCallStatus;
		let reply: HostToWorkerMessage;
		try {
			const tool = (isTool ? this.tools : this.globals).get(name);
			if (!tool) throw new Error(`Unknown ${isTool ? "tool" : "global"} "${name}"`);
			const args: unknown = message.args === undefined ? undefined : JSON.parse(message.args);
			const value = await tool.execute(args, { signal: pending.controller.signal });
			reply = { type: "result", id, ok: true, payload: value === undefined ? undefined : JSON.stringify(value) };
			status = "ok";
		} catch (error) {
			reply = { type: "result", id, ok: false, payload: errorMessage(error) };
			status = "error";
		}

		// 已由 finish() 取消：记录会保留 "cancelled" 状态，工作线程已经退出或正在退出。
		if (!this.pending.delete(id)) return;
		if (record) {
			record.status = status;
			record.durationMs = performance.now() - pending.startedAt;
		}
		this.post(reply);
	}

	private finish(error: CodemodeError | undefined, value?: unknown, writes?: CodemodeStoreWrites): void {
		if (this.finished) return;
		this.finished = true;
		clearTimeout(this.timer);
		this.signal?.removeEventListener("abort", this.onAbort);

		const now = performance.now();
		for (const pending of this.pending.values()) {
			if (pending.record) pending.record.durationMs = now - pending.startedAt;
			pending.controller.abort();
		}
		this.pending.clear();

		const result: CodemodeResult = error
			? { ok: false, error, output: this.output, calls: this.calls }
			: {
					ok: true,
					value,
					output: this.output,
					calls: this.calls,
					storeWrites: writes ?? { set: {}, delete: [] },
				};
		if (!this.worker) {
			this.resolveResult(result);
			return;
		}
		Atomics.store(new Int32Array(this.interrupt), 0, 1);
		this.worker
			.terminate()
			.catch(() => undefined)
			.then(() => this.resolveResult(result));
	}
}

/**
 * 在工作线程内的 QuickJS 虚拟机（独立的 wasm 实例）中运行 JavaScript。
 * 脚本可以使用每个已注册工具对应的 `tools.<name>(args)`、`ALL_TOOLS`、
 * 输出辅助函数 `text`、`image`、`exit` 和 `console.*`、`store`/`load`，以及已配置的全局变量；
 * 不提供其他能力（例如定时器、`fetch`、`process`、`require` 和模块）。
 *
 * 每次 `execute()` 都会使用独立的工作线程和虚拟机；沙箱仅保存工具表和默认配置。
 * `close()` 会中止正在执行的任务。
 */
export class CodemodeSandbox {
	private readonly toolsByName = new Map<string, CodemodeTool>();
	private readonly globalsByName = new Map<string, CodemodeTool>();
	private readonly timeoutMs: number;
	private readonly memoryLimitBytes: number | undefined;
	private readonly wasm: CodemodeWasmModule | Promise<CodemodeWasmModule> | undefined;
	private readonly workerUrl: string | URL;
	private readonly running = new Set<Execution>();
	private closed = false;

	constructor(options: CodemodeSandboxOptions = {}) {
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.memoryLimitBytes = options.memoryLimitBytes;
		this.wasm = options.wasm;
		this.workerUrl = options.workerUrl ?? defaultWorkerUrl();
		for (const tool of options.tools ?? []) this.registerTool(tool);
		const namespaces = new Set<string>();
		for (const global of options.globals ?? []) {
			const parts = global.name.split(".");
			if (parts.length > 2 || !parts.every((part) => IDENTIFIER.test(part)) || RESERVED_GLOBALS.has(parts[0])) {
				throw new Error(`Invalid global name "${global.name}"`);
			}
			if (this.globalsByName.has(global.name)) throw new Error(`Global "${global.name}" is already registered`);
			if (parts.length === 2) namespaces.add(parts[0]);
			this.globalsByName.set(global.name, global);
		}
		for (const name of namespaces) {
			if (this.globalsByName.has(name)) throw new Error(`Global "${name}" conflicts with the namespace "${name}"`);
		}
	}

	/** 如果已注册同名工具，则抛出异常。 */
	registerTool(tool: CodemodeTool): void {
		if (this.toolsByName.has(tool.name)) throw new Error(`Tool "${tool.name}" is already registered`);
		this.toolsByName.set(tool.name, tool);
	}

	unregisterTool(name: string): boolean {
		return this.toolsByName.delete(name);
	}

	get tools(): CodemodeTool[] {
		return [...this.toolsByName.values()];
	}

	get globals(): CodemodeTool[] {
		return [...this.globalsByName.values()];
	}

	/**
	 * `code` 是异步函数体，因此可以使用 `return` 和顶层 `await`。
	 * 脚本失败不会导致此方法拒绝，而是通过 `{ ok: false }` 返回。
	 * 脚本可以通过 `options.store` 使用 `store(key, value)` 和 `load(key)`。
	 */
	execute(code: string, options: CodemodeExecuteOptions = {}): Promise<CodemodeResult> {
		if (this.closed) return Promise.reject(new Error("Sandbox is closed"));
		const execution = new Execution({
			code,
			tools: new Map(this.toolsByName),
			globals: this.globalsByName,
			timeoutMs: options.timeoutMs ?? this.timeoutMs,
			signal: options.signal,
			memoryLimitBytes: this.memoryLimitBytes,
			store: serializeStore(options.store),
			wasm: this.wasm === undefined ? loadQuickJSWasm() : Promise.resolve(this.wasm),
			workerUrl: this.workerUrl,
		});
		this.running.add(execution);
		return execution.promise.finally(() => this.running.delete(execution));
	}

	/** 中止正在执行的任务（以 `kind: "aborted"` 结束），并拒绝新任务。 */
	async close(): Promise<void> {
		this.closed = true;
		await Promise.all([...this.running].map((execution) => execution.abort("Sandbox closed")));
	}
}
