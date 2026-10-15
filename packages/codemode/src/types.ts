import type { CodemodeWasmModule } from "./wasm.ts";

export interface CodemodeToolContext {
	/**
	 * 在脚本结束（包括未 await 的调用）、执行超时、调用方中止或
	 * sandbox 关闭时中止。
	 */
	signal: AbortSignal;
}

/** 一个 JSON Schema 文档。仅用于渲染声明；值不会对照它做校验。 */
export type CodemodeJsonSchema = { [key: string]: unknown } | boolean;

export interface CodemodeTool {
	/**
	 * 脚本以 `tools.<id>(args)` 形式调用工具，其中 `<id>` 是名称中标识符不合法的字符被替换成 `_`
	 * 后的结果（见 `toCodemodeIdentifier`），也可以 `tools["<name>"](args)` 形式调用。全局项以
	 * `<name>(args)` 形式调用且必须是标识符，或者 `<namespace>.<member>` 形式——后者会被分组进一个冻结的
	 * 命名空间对象。
	 */
	name: string;
	/** 在 {@link renderDeclarations} 中显示为 doc comment，并列入工具的 `ALL_TOOLS`。 */
	description?: string;
	/** 单个参数的 schema。渲染为参数类型；省略时为 `unknown`。 */
	inputSchema?: CodemodeJsonSchema;
	/** 已结算值的 schema。渲染为 promise 类型；省略时为 `unknown`。 */
	outputSchema?: CodemodeJsonSchema;
	/** 仅用于全局项（globals）：`execute` 收到全部调用参数组成的数组，而不是第一个参数。 */
	spread?: boolean;
	/**
	 * 仅用于全局项：供 {@link renderDeclarations} 使用的 TypeScript 参数列表与返回类型，例如
	 * `(type: string, id?: string): Promise<Model[]>`。用于替代由 schema 生成的渲染。
	 */
	signature?: string;
	/**
	 * `args` 是脚本传入的内容，经过一次 JSON 往返。返回值必须可 JSON 序列化；抛出的错误会以
	 * 一个相同 message 的 `Error` 形式出现在脚本一侧。
	 */
	execute(args: unknown, context: CodemodeToolContext): Promise<unknown> | unknown;
}

/**
 * 脚本输出的一项，按脚本产生的顺序排列：`text()` 与 `console.*` 产生文本项（`console.*` 带
 * `console: true`），`image()` 产生图片项。`data` 为 base64。
 */
export type CodemodeOutputItem =
	| { type: "text"; text: string; console?: true }
	| { type: "image"; data: string; mimeType: string };

export type CodemodeCallStatus = "ok" | "error" | "cancelled";

export interface CodemodeCall {
	name: string;
	status: CodemodeCallStatus;
	durationMs: number;
}

export type CodemodeErrorKind =
	/** 脚本抛错或解析失败。`name` 与 `stack` 来自脚本的错误。 */
	| "script"
	/** 总体 deadline 已过。worker 已被终止。 */
	| "timeout"
	/** 调用方的 signal 触发或 sandbox 已关闭。worker 已被终止。 */
	| "aborted"
	/** worker 或 VM 在脚本可控范围之外失败（例如 wasm trap 或缺少 worker 文件）。 */
	| "sandbox";

export interface CodemodeError {
	kind: CodemodeErrorKind;
	name?: string;
	message: string;
	stack?: string;
}

/** 脚本通过 `store()` 改变的键。只有成功执行会报告写入。 */
export interface CodemodeStoreWrites {
	set: Record<string, unknown>;
	/** 存为 `undefined` 的键。 */
	delete: string[];
}

/** 失败的执行也保留 `output`，直到发生失败为止。`exit()` 会以 `value: undefined` 完成。 */
export type CodemodeResult =
	| {
			ok: true;
			value: unknown;
			output: CodemodeOutputItem[];
			calls: CodemodeCall[];
			storeWrites: CodemodeStoreWrites;
	  }
	| { ok: false; error: CodemodeError; output: CodemodeOutputItem[]; calls: CodemodeCall[] };

export interface CodemodeSandboxOptions {
	tools?: CodemodeTool[];
	/**
	 * 以顶级标识符（而非挂在 `tools` 上）暴露的函数，用于宿主辅助操作，例如把图片附加到结果。
	 * 它们的行为类似工具（JSON 往返、返回 promise），但不会记录进 `result.calls`。名称必须是标识符，
	 * 且不得遮蔽内置全局项（`tools`、`ALL_TOOLS`、`console`、`text`、`image`、`exit`、`store`、`load`）。
	 */
	globals?: CodemodeTool[];
	/**
	 * 每次执行的总体 deadline，包括在工具中花费的时间。`Infinity` 代表禁用 deadline；此时执行只会在脚本
	 * 落定或被中止时结束。默认：300000。
	 */
	timeoutMs?: number;
	/**
	 * QuickJS VM 允许分配的最大内存。超过限制的分配会在脚本内以
	 * `InternalError: out of memory` 失败。默认：除 wasm32 的 4 GiB 地址空间外无限制。
	 */
	memoryLimitBytes?: number;
	/**
	 * 编译好的 `quickjs-wasi/quickjs.wasm`，常来自 {@link loadQuickJSWasm}。默认：
	 * `loadQuickJSWasm()`，即已安装的 `quickjs-wasi` 包中的文件。当该文件不在磁盘上时传入，
	 * 例如在 Bun 编译的可执行文件中。
	 */
	wasm?: CodemodeWasmModule | Promise<CodemodeWasmModule>;
	/**
	 * 引入 `@earendil-works/pi-codemode/worker` 的 worker 入口。默认：本包自带的
	 * worker 文件。本包被打包（bundle）时请传入，因为默认值是相对于创建 sandbox 的模块解析的。
	 * Bun 编译的可执行文件需要内嵌构建入口的相对字符串 specifier；其他宿主通常使用 URL。
	 */
	workerUrl?: string | URL;
}

export interface CodemodeExecuteOptions {
	signal?: AbortSignal;
	/** 覆盖本次执行的 sandbox 默认值。 */
	timeoutMs?: number;
	/**
	 * 脚本通过 `load(key)` 读取的值。必须可 JSON 序列化。脚本自己的
	 * `store()` 调用会以 `result.storeWrites` 返回；是否持久化由调用方决定。
	 */
	store?: Readonly<Record<string, unknown>>;
}
