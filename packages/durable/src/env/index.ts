import type { Context } from "@earendil-works/chord";

/** 可能失败的操作的结果。预期中的失败以返回值表达，而不是抛出。 */
export type Result<TValue, TError> = { ok: true; value: TValue } | { ok: false; error: TError };

export function ok<TValue, TError>(value: TValue): Result<TValue, TError> {
	return { ok: true, value };
}

export function err<TValue, TError>(error: TError): Result<TValue, TError> {
	return { ok: false, error };
}

export function getOrThrow<TValue, TError>(result: Result<TValue, TError>): TValue {
	if (!result.ok) throw result.error;
	return result.value;
}

export function getOrUndefined<TValue extends object, TError>(result: Result<TValue, TError>): TValue | undefined {
	return result.ok ? result.value : undefined;
}

export function toError(error: unknown): Error {
	if (error instanceof Error) return error;
	if (typeof error === "string") return new Error(error);
	try {
		return new Error(JSON.stringify(error));
	} catch {
		return new Error(String(error));
	}
}

export type FileKind = "file" | "directory" | "symlink";

export type FileErrorCode =
	| "aborted"
	| "not_found"
	| "permission_denied"
	| "not_directory"
	| "is_directory"
	| "invalid"
	| "not_supported"
	| "unknown";

export class FileError extends Error {
	public code: FileErrorCode;
	public path?: string;

	constructor(code: FileErrorCode, message: string, path?: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "FileError";
		this.code = code;
		this.path = path;
	}
}

export type ExecutionErrorCode =
	| "aborted"
	| "timeout"
	| "shell_unavailable"
	| "spawn_error"
	| "callback_error"
	| "unknown";

export class ExecutionError extends Error {
	public code: ExecutionErrorCode;
	/** 命令超时或被中止、且其输出超过溢出（spill）阈值后，完整输出所在的溢出文件。 */
	public spillPath?: string;

	constructor(code: ExecutionErrorCode, message: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "ExecutionError";
		this.code = code;
	}
}

export interface FileInfo {
	name: string;
	path: string;
	kind: FileKind;
	size: number;
	mtimeMs: number;
}

export interface TextLine {
	text: string;
	terminated: boolean;
}

export interface TextLineReader {
	readLine(context: Context): Promise<Result<TextLine | undefined, FileError>>;
	close(context: Context): Promise<void>;
}

/** 对单个已打开常规文件的按位置读取；即使其路径被重命名，所有调用看到的仍是同一个文件。 */
export interface BinaryReader {
	/** 已打开文件的元数据，而非其路径当前所指对象的元数据。 */
	info(context: Context): Promise<Result<FileInfo, FileError>>;
	/** 读取 `offset` 处至多 `length` 个字节；只有到文件末尾时才会少于该值。 */
	read(offset: number, length: number, context: Context): Promise<Result<Uint8Array, FileError>>;
	/**
	 * 一次遍历文件，定位 `[startLine, endLine)` 范围的行（缺省 `endLine` 表示直到结尾），从 0 计数，第 `k` 行
	 * 开始于第 `k` 个换行字节之后。解码后的大小与 `new TextDecoder().decode(file)` 对该范围产出的文本一致，
	 * 因此文件开头的字节序标记（BOM）不计入。
	 */
	scanLines(options: { startLine: number; endLine?: number }, context: Context): Promise<Result<LineScan, FileError>>;
	close(context: Context): Promise<void>;
}

/** 要监视的文件或目录。它可以不存在；创建它就是一次变更。 */
export interface WatchTarget {
	path: string;
	/** 监视目录下的一切，而不只是其直接条目。目录下方的符号链接不会被跟随。 */
	recursive?: boolean;
	/** `path` 之下既不监视也不上报的条目：以 `.` 开头的名称，或这些名称。 */
	exclude?: { hidden?: boolean; names?: readonly string[] };
}

/**
 * 发生了什么变化：
 * - `paths`：每个路径处或其下方的内容可能发生了变化（目录路径覆盖其整个子树）。回调可能是虚假的；只要监视器健康，
 *   变更就绝不会漏报。
 * - `overflow`：一段时间内覆盖不可靠（事件丢失、重新连接）；请重新扫描所有被监视的内容。
 * - `error`：监视器已停止，例如被监视的树超出了环境的限制；此后不会再有回调。
 */
export type WatchChange = { paths: string[] } | { overflow: true } | { error: FileError };

export interface FileWatcher {
	/**
	 * `native`：变更在大约两秒内上报。`polling`：环境通过比较快照来发现变更，因为文件系统无法可靠上报变更
	 * （网络与 FUSE 文件系统）；在两次快照之间被撤销的变更可能被漏掉。
	 */
	readonly mode: "native" | "polling";
	/** 停止监视；此调用完成之后不会再触发 `onChange`。幂等。 */
	close(context: Context): Promise<void>;
}

/** 文件中各行的位置，按 `BinaryReader.scanLines` 扫描到的结果。 */
export interface LineScan {
	/** 整个文件中的换行字节数；文件共有 `newlines + 1` 行。 */
	newlines: number;
	/**
	 * 选中行的字节范围：从第一行的开头到最后一行的结尾（含结尾换行符之前）。超出最后一行的选择在文件末尾处为空。
	 */
	start: number;
	end: number;
	/** 第一条选中行的结束位置：其换行符，或文件末尾。 */
	firstLineEnd: number;
	/** 最后一条选中行的起始位置。 */
	lastLineStart: number;
	/** 选中范围及其第一行解码后的 UTF-8 字节长度。 */
	selectedBytes: number;
	firstLineBytes: number;
}

/** 单个目录条目的分页读取器。 */
export interface DirReader {
	/**
	 * 按文件系统返回的顺序、从上次调用停止之处继续，返回至多 `maxEntries` 个条目。`done` 表示结束；它可能伴随
	 * 最后一批条目出现，也可能伴随空页出现。元数据读取前就已消失的条目会被跳过，不支持种类的条目同样被跳过。
	 * 调用失败或被中止后，请关闭该读取器。
	 */
	next(maxEntries: number, context: Context): Promise<Result<{ entries: FileInfo[]; done: boolean }, FileError>>;
	close(context: Context): Promise<void>;
}

/** 可移植的文件系域能力。操作以返回值表达失败，而不是抛出。 */
export interface FileSystem {
	/**
	 * 文件命名空间：相同 id 的环境在相同路径看到相同的文件，无论其 `cwd` 是什么。所有本地 Node 环境共享同一个
	 * id；每个容器或远程主机各有自己的 id。
	 */
	readonly id: string;
	cwd: string;
	absolutePath(path: string, context: Context): Promise<Result<string, FileError>>;
	joinPath(parts: string[], context: Context): Promise<Result<string, FileError>>;
	readTextFile(path: string, context: Context): Promise<Result<string, FileError>>;
	openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>>;
	readTextLines(
		path: string,
		options: { maxLines?: number } | undefined,
		context: Context,
	): Promise<Result<string[], FileError>>;
	readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>>;
	/**
	 * 打开一个常规文件以进行有界的按位置读取。目录会以 `is_directory` 失败，其他非常规文件以 `invalid` 失败。
	 * 设置 `noFollow` 时，路径最后一个分量为符号链接会以 `invalid` 失败，而不会被跟随；前面的分量仍会被解析。
	 */
	openBinaryReader(
		path: string,
		options: { noFollow?: boolean } | undefined,
		context: Context,
	): Promise<Result<BinaryReader, FileError>>;
	writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>>;
	appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>>;
	/** 将文件截断或扩展到恰好 `size` 字节。 */
	truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>>;
	/** 刷写文件内容及其元数据，确保日后能从已打开的文件句柄中重新取得这些内容。 */
	flushFile(path: string, context: Context): Promise<Result<void, FileError>>;
	renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>>;
	fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>>;
	listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>>;
	openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>>;
	/**
	 * 上报文件与目录的变更，供从环境中加载资源的主机使用。当返回的监视器存在时，覆盖即已建立：在加载之前就
	 * 开始监视的主机不会漏掉加载期间发生的变更。上报内容见 `WatchChange`，可靠程度见 `FileWatcher.mode`。
	 */
	watch(
		targets: readonly WatchTarget[],
		onChange: (change: WatchChange) => void,
		context: Context,
	): Promise<Result<FileWatcher, FileError>>;
	canonicalPath(path: string, context: Context): Promise<Result<string, FileError>>;
	exists(path: string, context: Context): Promise<Result<boolean, FileError>>;
	createDir(
		path: string,
		options: { recursive?: boolean } | undefined,
		context: Context,
	): Promise<Result<void, FileError>>;
	remove(
		path: string,
		options: { recursive?: boolean; force?: boolean } | undefined,
		context: Context,
	): Promise<Result<void, FileError>>;
	createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>>;
	createTempFile(
		options: { prefix?: string; suffix?: string } | undefined,
		context: Context,
	): Promise<Result<string, FileError>>;
	cleanup(context: Context): Promise<void>;
}

/** 一旦输出超过任一阈值，就把完整输出溢写（spill）到临时文件。 */
export interface ShellSpillOptions {
	afterBytes: number;
	/** 以完整行或部分行计。 */
	afterLines: number;
}

export interface ShellExecResult {
	exitCode: number;
	/** 超过溢写阈值时，保存完整原始输出的临时文件。 */
	spillPath?: string;
}

export interface ShellExecOptions {
	cwd?: string;
	env?: Record<string, string>;
	inheritEnv?: boolean;
	timeout?: number;
	/**
	 * stdout 与 stderr 的每个解码分块，按到达顺序连同其来源流一起回调：原始、无上限、不限速。每个流单独解码，
	 * 因此跨分块被拆开的字符不会丢失。
	 */
	onOutput?: (text: string, context: Context, info: ShellOutputInfo) => void;
	spill?: ShellSpillOptions;
	/**
	 * 调用方只保留输出的这一段尾部，环境因此可以省略此窗口之外的输出，并通过 `info.skipped` 上报省略。
	 * 不设置时，每个分块都会被送达。
	 */
	window?: ShellOutputWindow;
}

/**
 * 调用方在合并输出中保留的尾部，及其采样频率。需要经慢速链路传输输出的环境可借此省略调用方反正会丢弃的内容，
 * 并保证发送速度不超过调用方的提交速度。
 */
export interface ShellOutputWindow {
	/** 在输出末尾保留的解码文本的 UTF-8 字节数。 */
	maxBytes: number;
	/** 在输出末尾保留的行数。 */
	maxLines: number;
	/** 调用方两次采样输出之间的最小间隔。 */
	minIntervalMs: number;
	/** 每次采样还会按此速率，与采样大小成比例地暂停调用方。 */
	bytesPerSecond: number;
}

/**
 * 环境省略掉的输出，以 `onOutput` 本应收到的解码文本计量：每个 U+FFFD 按三字节计，且不做任何清洗（sanitize）。
 */
export interface ShellOutputSkip {
	/** 被省略文本的 UTF-8 字节长度。 */
	bytes: number;
	/** 被省略文本中的换行符（U+000A）数量。 */
	newlines: number;
	/** 被省略文本是否以换行符结尾。 */
	endsWithNewline: boolean;
}

export interface ShellOutputInfo {
	stream: "stdout" | "stderr";
	/**
	 * 紧邻本分块之前被省略的输出，仅在设置 `window` 时出现。此时本分块承载省略之后直至其结束前的全部输出，
	 * 且超出窗口至少一个字节或一行：多于 `window.maxBytes` 字节，或多于 `window.maxLines` 个换行。因此被省略的
	 * 文本绝不可能落在保留的尾部之内。省略与这样的分块可能按到达顺序横跨两个流；此时 `stream` 给出该分块
	 * 最后所在的流。需要区分两个流的调用方不应传 `window`。
	 */
	skipped?: ShellOutputSkip;
}

export interface Shell {
	/**
	 * 运行一条命令。字符串形式的命令会经由环境的 shell 执行。数组形式则直接运行 `command[0]`，其余元素作为其
	 * 参数，不经过 shell，因此参数会未经解析地送达程序。中止 context 或超时只会终止该命令自身的进程。
	 */
	exec(
		command: string | readonly string[],
		options: ShellExecOptions | undefined,
		context: Context,
	): Promise<Result<ShellExecResult, ExecutionError>>;
	/** 终止此环境仍在运行的所有命令；用于其所有者的关闭流程，绝不要用于单个请求。 */
	cleanup(context: Context): Promise<void>;
}

export interface ExecutionEnv extends FileSystem, Shell {}

export { rangeDecoder, StreamDecoder, startsWithBom } from "./decode.ts";
export { LineScanner } from "./line-scan.ts";
