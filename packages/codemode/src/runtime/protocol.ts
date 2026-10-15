import type { CodemodeOutputItem } from "../types.ts";
import type { CodemodeWasmModule } from "../wasm.ts";

/**
 * 宿主（主线程）与工作线程之间传递的消息。工具参数、结果和值均以 JSON 字符串传递：
 * 工作线程将这些字符串传入和传出 QuickJS 虚拟机，本身不会构建结构化值。
 */

export interface WorkerData {
	code: string;
	/** `jsName` 是脚本使用的标识符；`description` 会列在 `ALL_TOOLS` 中。 */
	tools: { name: string; jsName: string; description: string }[];
	globals: { name: string; spread: boolean }[];
	/** 已编译的 `quickjs-wasi` 模块。结构化克隆会将已编译代码共享给工作线程。 */
	wasm: CodemodeWasmModule;
	memoryLimitBytes: number | undefined;
	/** `load()` 使用的快照：键映射到 JSON 文本。 */
	store: Record<string, string>;
	/**
	 * 宿主会在终止工作线程前将此 Int32 设为非零。虚拟机的中断处理器会轮询它，
	 * 因为 Bun 的 `worker.terminate()` 无法停止正在 wasm 中死循环的线程。
	 */
	interrupt: SharedArrayBuffer;
}

/** 脚本抛出错误的 JSON 编码，格式为 `{ name?, message, stack? }`。 */
export type ScriptErrorJson = string;

export type WorkerToHostMessage =
	| { type: "call"; id: number; target: "tool" | "global"; name: string; args: string | undefined }
	| { type: "output"; item: CodemodeOutputItem }
	/** `writes` 是 JSON 数组；`store()` 写入项为 `[key, json]`，删除项为 `[key]`。 */
	| { type: "done"; ok: true; value: string | undefined; writes: string }
	| { type: "done"; ok: false; error: ScriptErrorJson }
	/** 虚拟机发生了脚本无法控制的故障，例如 wasm 陷阱。 */
	| { type: "crash"; message: string };

export type HostToWorkerMessage =
	/** `ok` 为真时，`payload` 是 JSON 结果；否则它是错误消息。 */
	{ type: "result"; id: number; ok: boolean; payload: string | undefined };

export function isWorkerToHostMessage(value: unknown): value is WorkerToHostMessage {
	if (typeof value !== "object" || value === null) return false;
	const type = (value as { type?: unknown }).type;
	return type === "call" || type === "output" || type === "done" || type === "crash";
}

export function isHostToWorkerMessage(value: unknown): value is HostToWorkerMessage {
	return typeof value === "object" && value !== null && (value as { type?: unknown }).type === "result";
}
