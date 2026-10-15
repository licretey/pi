import { randomUUID } from "node:crypto";
import { type PlatformPath, posix, win32 } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import type { Context } from "@earendil-works/chord";
import {
	type BinaryReader,
	type DirReader,
	type ExecutionEnv,
	ExecutionError,
	err,
	FileError,
	type FileInfo,
	type FileKind,
	type FileWatcher,
	type LineScan,
	ok,
	type Result,
	type ShellExecOptions,
	type ShellExecResult,
	type ShellOutputInfo,
	type ShellOutputSkip,
	StreamDecoder,
	type TextLine,
	type TextLineReader,
	type WatchChange,
	type WatchTarget,
} from "@earendil-works/pi-durable/env";
import { type Connection, type Json, RemoteError, type RemoteInfo } from "./connection.ts";
import { abortResult, toFileError } from "./errors.ts";
import { RemoteWatcher, type RemoteWatchOptions } from "./watch.ts";

const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;
/** 二进制读取器每次 `pread` 请求读取的字节数；多个请求可并行进行。 */
const READ_CHUNK = 256 * 1024;
const READ_DEPTH = 8;
/** Node 的 `writeFile` 每次调用最多写入这么多字节，并在每次写入前检查是否已中止。 */
const WRITE_CHUNK = 512 * 1024;
const WRITE_DEPTH = 8;
/** Node 的 `readFile` 参数：已知大小读取的分块大小、未知大小读取的分块大小，以及可读取的最大文件大小。 */
const READ_FILE_CHUNK = 512 * 1024;
const READ_FILE_UNKNOWN_CHUNK = 64 * 1024;
const READ_FILE_MAX = 2 ** 31 - 1;
/** `NodeTextLineReader` 每次读取的字节数。 */
const LINE_CHUNK = 64 * 1024;

export interface RemoteExecutionEnvOptions {
	connection: Connection;
	/** 文件命名空间：相同 ID 可访问相同文件（`FileSystem.id`），例如 `pi-env:<env name>`。 */
	id: string;
	cwd: string;
	shellPath?: string;
	/** 添加到每个继承该环境的远程命令中，例如 `NodeExecutionEnv` 的 `shellEnv`。 */
	shellEnv?: Record<string, string>;
	/** 守护进程的文件监视方式，例如 `NodeExecutionEnv` 的 `watch` 选项。 */
	watch?: RemoteWatchOptions;
}

/** 守护进程返回的信息记录。 */
type RemoteFileInfo = { name: string; kind: FileKind | "other"; size: number; mtimeSec: number; mtimeNsec: number };
type RemoteDirEntry = { name: string; raw?: number[]; info?: RemoteFileInfo; error?: Json };

/** 远程系统使用的 Node 路径规则。 */
export async function remotePath(connection: Connection): Promise<PlatformPath> {
	return (await connection.info()).os === "windows" ? win32 : posix;
}

function toInfo(path: string, remote: RemoteFileInfo, paths: PlatformPath): Result<FileInfo, FileError> {
	if (remote.kind === "other") return err(new FileError("invalid", "Unsupported file type", path));
	return ok({
		name: paths.basename(path),
		path,
		kind: remote.kind,
		size: remote.size,
		mtimeMs: remote.mtimeSec * 1000 + remote.mtimeNsec / 1e6,
	});
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
	if (chunks.length === 1) return chunks[0]!;
	const bytes = new Uint8Array(total);
	let position = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, position);
		position += chunk.length;
	}
	return bytes;
}

/**
 * 从 `offset` 开始读取 `length` 字节，每次最多读取 `chunk` 字节，并允许多个读取同时进行。到达文件末尾时提前结束。
 * 如果某次读取返回的字节数较少，则从该位置继续读取，与顺序读取的行为一致。每次读取后都会检查 `aborted`；
 * 返回 `undefined` 表示操作已中止。
 */
async function readRange(
	read: (offset: number, length: number) => Promise<Uint8Array>,
	offset: number,
	length: number,
	chunk: number,
	aborted: () => boolean,
): Promise<{ chunks: Uint8Array[]; total: number } | undefined> {
	const chunks: Uint8Array[] = [];
	let total = 0;
	let next = offset;
	const inFlight: { length: number; bytes: Promise<Uint8Array> }[] = [];
	while (total < length) {
		while (inFlight.length < READ_DEPTH && next < offset + length) {
			const size = Math.min(offset + length - next, chunk);
			const bytes = read(next, size);
			bytes.catch(() => {});
			inFlight.push({ length: size, bytes });
			next += size;
		}
		const head = inFlight.shift()!;
		const bytes = await head.bytes;
		if (aborted()) return undefined;
		if (bytes.length === 0) break;
		chunks.push(bytes);
		total += bytes.length;
		if (bytes.length < head.length) {
			// 已在进行中的读取按完整读取处理；从本次读取结束的位置继续。
			inFlight.length = 0;
			next = offset + total;
		}
	}
	return { chunks, total };
}

/** 守护进程句柄：仅在打开它的会话中有效。 */
class Handle {
	readonly env: RemoteExecutionEnv;
	readonly id: number;
	readonly session: number;
	readonly path: string;

	constructor(env: RemoteExecutionEnv, id: number, session: number, path: string) {
		this.env = env;
		this.id = id;
		this.session = session;
		this.path = path;
	}

	request(op: string, json: Json = {}, options: { signal?: AbortSignal; payload?: Uint8Array } = {}) {
		return this.env.connection.request(op, { ...json, handle: this.id }, { ...options, session: this.session });
	}

	async pread(offset: number | undefined, length: number): Promise<Uint8Array> {
		return (await this.request("pread", { ...(offset === undefined ? {} : { offset }), length })).payload;
	}

	async close(): Promise<void> {
		await this.request("close").catch(() => undefined);
	}
}

class RemoteBinaryReader implements BinaryReader {
	readonly #handle: Handle;
	#closed = false;

	constructor(handle: Handle) {
		this.#handle = handle;
	}

	get #path(): string {
		return this.#handle.path;
	}

	#closedResult<T>(): Result<T, FileError> | undefined {
		return this.#closed ? err(new FileError("invalid", "Binary reader is closed", this.#path)) : undefined;
	}

	async info(context: Context): Promise<Result<FileInfo, FileError>> {
		const early = abortResult<FileInfo>(context.abortSignal, this.#path) ?? this.#closedResult<FileInfo>();
		if (early) return early;
		try {
			const { json } = await this.#handle.request("fstat");
			return toInfo(this.#path, json as unknown as RemoteFileInfo, await remotePath(this.#handle.env.connection));
		} catch (error) {
			return err(toFileError(error, this.#path));
		}
	}

	async read(offset: number, length: number, context: Context): Promise<Result<Uint8Array, FileError>> {
		const early = abortResult<Uint8Array>(context.abortSignal, this.#path) ?? this.#closedResult<Uint8Array>();
		if (early) return early;
		if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
			return err(new FileError("invalid", "Offset and length must be non-negative safe integers", this.#path));
		}
		try {
			const read = await readRange(
				(at, size) => this.#handle.pread(at, size),
				offset,
				length,
				READ_CHUNK,
				() => context.abortSignal?.aborted === true,
			);
			if (read === undefined) return err(new FileError("aborted", "aborted", this.#path));
			return ok(concat(read.chunks, read.total));
		} catch (error) {
			return err(toFileError(error, this.#path));
		}
	}

	async scanLines(
		options: { startLine: number; endLine?: number },
		context: Context,
	): Promise<Result<LineScan, FileError>> {
		const early = abortResult<LineScan>(context.abortSignal, this.#path) ?? this.#closedResult<LineScan>();
		if (early) return early;
		const { startLine, endLine } = options;
		if (
			!Number.isSafeInteger(startLine) ||
			startLine < 0 ||
			(endLine !== undefined && (!Number.isSafeInteger(endLine) || endLine <= startLine))
		) {
			return err(new FileError("invalid", "Invalid line range", this.#path));
		}
		try {
			const { json } = await this.#handle.request(
				"scanLines",
				{ startLine, ...(endLine === undefined ? {} : { endLine }) },
				context.abortSignal ? { signal: context.abortSignal } : {},
			);
			return ok(json as unknown as LineScan);
		} catch (error) {
			return err(toFileError(error, this.#path));
		}
	}

	async close(_context: Context): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await this.#handle.close();
	}
}

class RemoteDirReader implements DirReader {
	readonly #handle: Handle;
	#done = false;
	#closed = false;

	constructor(handle: Handle) {
		this.#handle = handle;
	}

	async next(
		maxEntries: number,
		context: Context,
	): Promise<Result<{ entries: FileInfo[]; done: boolean }, FileError>> {
		const path = this.#handle.path;
		const aborted = abortResult<{ entries: FileInfo[]; done: boolean }>(context.abortSignal, path);
		if (aborted) return aborted;
		if (this.#closed) return err(new FileError("invalid", "Directory reader is closed", path));
		if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
			return err(new FileError("invalid", "maxEntries must be a positive safe integer", path));
		}
		const entries: FileInfo[] = [];
		try {
			const paths = await remotePath(this.#handle.env.connection);
			// 与 `NodeDirReader` 一样，只统计属于当前目录列表的条目。
			while (!this.#done && entries.length < maxEntries) {
				const { json } = await this.#handle.request("readdir", { max: maxEntries - entries.length });
				const loopAbort = abortResult<{ entries: FileInfo[]; done: boolean }>(context.abortSignal, path);
				if (loopAbort) return loopAbort;
				for (const entry of json.entries as RemoteDirEntry[]) {
					const entryPath = paths.resolve(path, entry.name);
					if (entry.error !== undefined) {
						// 条目在枚举后、执行 lstat 前已被删除，因此不再属于当前列表。
						if (entry.error.code === "ENOENT") continue;
						return err(toFileError(new RemoteError(entry.error), entryPath));
					}
					const info = toInfo(entryPath, entry.info!, paths);
					if (info.ok) entries.push(info.value);
				}
				this.#done = json.done === true;
			}
			return ok({ entries, done: this.#done });
		} catch (error) {
			return err(toFileError(error, path));
		}
	}

	async close(_context: Context): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await this.#handle.close();
	}
}

/** `NodeTextLineReader`：对以 `open(path, "r")` 方式打开的文件执行定位读取。 */
class RemoteTextLineReader implements TextLineReader {
	readonly #handle: Handle;
	readonly #decoder = new StreamDecoder();
	#offset = 0;
	#buffered = "";
	#ended = false;
	#closed = false;

	constructor(handle: Handle) {
		this.#handle = handle;
	}

	async readLine(context: Context): Promise<Result<TextLine | undefined, FileError>> {
		const path = this.#handle.path;
		const aborted = abortResult<TextLine | undefined>(context.abortSignal, path);
		if (aborted) return aborted;
		if (this.#closed) return err(new FileError("invalid", "Text line reader is closed", path));
		try {
			while (true) {
				const newline = this.#buffered.indexOf("\n");
				if (newline !== -1) {
					const text = this.#buffered.slice(0, newline);
					this.#buffered = this.#buffered.slice(newline + 1);
					return ok({ text, terminated: true });
				}
				if (this.#ended) {
					if (this.#buffered.length === 0) return ok(undefined);
					const text = this.#buffered;
					this.#buffered = "";
					return ok({ text, terminated: false });
				}
				const bytes = await this.#handle.pread(this.#offset, LINE_CHUNK);
				const afterReadAbort = abortResult<TextLine | undefined>(context.abortSignal, path);
				if (afterReadAbort) return afterReadAbort;
				this.#offset += bytes.length;
				if (bytes.length === 0) {
					this.#buffered += this.#decoder.decode();
					this.#ended = true;
				} else {
					this.#buffered += this.#decoder.decode(bytes);
				}
			}
		} catch (error) {
			return err(toFileError(error, path));
		}
	}

	async close(_context: Context): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#buffered = "";
		await this.#handle.close();
	}
}

/**
 * 通过 pi-env 守护进程访问另一台机器上的 `ExecutionEnv`。结果与在该机器上运行 `NodeExecutionEnv` 相同：
 * 守护进程负责执行系统调用，本类负责遵循 Node 的路径、错误和结果处理规则。
 */
export class RemoteExecutionEnv implements ExecutionEnv {
	readonly id: string;
	cwd: string;
	readonly connection: Connection;
	readonly #shellPath: string | undefined;
	readonly #shellEnv: Record<string, string> | undefined;
	readonly #watchOptions: RemoteWatchOptions;
	/** 此环境启动且仍在运行的命令，供 `cleanup()` 清理。 */
	readonly #running = new Map<number, number>();

	constructor(options: RemoteExecutionEnvOptions) {
		this.id = options.id;
		this.cwd = options.cwd;
		this.connection = options.connection;
		this.#shellPath = options.shellPath;
		this.#shellEnv = options.shellEnv;
		this.#watchOptions = options.watch ?? {};
	}

	/** 在远程系统上按 Node 规则解析路径，并使用其主目录和各驱动器工作目录。 */
	async #resolve(path: string): Promise<string> {
		const info = await this.connection.info();
		const windows = info.os === "windows";
		const paths = windows ? win32 : posix;
		let normalized = path;
		if (normalized === "~") {
			normalized = info.home;
		} else if (normalized.startsWith("~/") || (windows && normalized.startsWith("~\\"))) {
			normalized = paths.join(info.home, normalized.slice(2));
		} else if (normalized.startsWith("file://")) {
			try {
				normalized = fileURLToPath(normalized, { windows });
			} catch {
				// 与 Node 一致，将格式错误的 URL 作为普通路径处理。
			}
		}
		if (paths.isAbsolute(normalized)) return paths.resolve(normalized);
		if (windows) {
			// 相对路径指定了另一个驱动器：Windows 上的 Node 会根据该驱动器的工作目录解析路径。
			// 先使用对应驱动器的工作目录（例如 `=D:`）；若该驱动器没有记录，则使用当前工作目录；否则回退到驱动器根目录。
			const drive = /^([a-zA-Z]:)(?![\\/])/.exec(normalized)?.[1];
			if (drive !== undefined && drive.toLowerCase() !== this.cwd.slice(0, 2).toLowerCase()) {
				let base = info.driveCwds[drive.toUpperCase()] ?? info.cwd;
				if (base.slice(0, 2).toLowerCase() !== drive.toLowerCase() && base[2] === "\\") base = `${drive}\\`;
				return win32.resolve(base, normalized);
			}
		}
		return paths.resolve(this.cwd, normalized);
	}

	async #fileOp<T>(
		path: string,
		context: Context,
		run: (resolved: string) => Promise<T>,
		check: "before" | "both" = "before",
	): Promise<Result<T, FileError>> {
		let resolved: string;
		try {
			resolved = await this.#resolve(path);
		} catch (error) {
			return err(toFileError(error, path));
		}
		const aborted = abortResult<T>(context.abortSignal, resolved);
		if (aborted) return aborted;
		try {
			const value = await run(resolved);
			if (check === "both") {
				const after = abortResult<T>(context.abortSignal, resolved);
				if (after) return after;
			}
			return ok(value);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async #open(resolved: string, json: Json): Promise<{ handle: Handle; json: Json }> {
		const reply = await this.connection.request("open", { path: resolved, ...json });
		return { handle: new Handle(this, reply.json.handle as number, reply.session, resolved), json: reply.json };
	}

	async absolutePath(path: string, _context: Context): Promise<Result<string, FileError>> {
		try {
			return ok(await this.#resolve(path));
		} catch (error) {
			return err(toFileError(error, path));
		}
	}

	async joinPath(parts: string[], _context: Context): Promise<Result<string, FileError>> {
		try {
			return ok((await remotePath(this.connection)).join(...parts));
		} catch (error) {
			return err(toFileError(error));
		}
	}

	/** 对通过 `open(path, "r")` 打开的文件执行 Node 的 `readFile`，可选择是否按 UTF-8 解码。 */
	async #readFile(path: string, encoding: boolean, context: Context): Promise<Result<Uint8Array | string, FileError>> {
		const signal = context.abortSignal;
		return this.#fileOp(path, context, async (resolved) => {
			const { handle, json } = await this.#open(resolved, { mode: "read" });
			const aborted = () => signal?.aborted === true;
			const abort = () => new FileError("aborted", "The operation was aborted", resolved);
			try {
				if (json.statError !== undefined) throw new RemoteError(json.statError as Json);
				if (aborted()) throw abort();
				const stat = json.stat as RemoteFileInfo;
				const size = stat.kind === "file" ? stat.size : 0;
				if (size > READ_FILE_MAX) {
					throw new FileError("unknown", `File size (${size}) is greater than 2 GiB`, resolved);
				}
				if (size === 0) {
					// 大小未知：逐次读取直至结束，FIFO 和设备也采用此方式。
					const decoder = new StringDecoder("utf8");
					const chunks: Uint8Array[] = [];
					let total = 0;
					let text = "";
					while (true) {
						if (aborted()) throw abort();
						const bytes = await handle.pread(undefined, READ_FILE_UNKNOWN_CHUNK);
						if (bytes.length === 0) break;
						total += bytes.length;
						chunks.push(bytes);
						if (encoding) text += decoder.write(bytes);
					}
					if (!encoding) return Buffer.concat(chunks, total);
					return total === 0 ? "" : text + decoder.end();
				}
				if (!encoding) {
					// 一次读取完整文件，或每次读取 512 KiB，直到达到文件大小或文件末尾。
					if (size <= READ_FILE_CHUNK) return Buffer.from(await handle.pread(0, size));
					const read = await readRange(
						(at, length) => handle.pread(at, length),
						0,
						size,
						READ_FILE_CHUNK,
						aborted,
					);
					if (read === undefined) throw abort();
					return Buffer.concat(read.chunks, read.total);
				}
				// 解码读取：每次读取 min(size, 512 KiB)，直到达到文件大小、发生短读取或到达文件末尾。
				const length = Math.min(size, READ_FILE_CHUNK);
				const decoder = new StringDecoder("utf8");
				let text = "";
				let total = 0;
				let first = true;
				const inFlight: Promise<Uint8Array>[] = [];
				let next = 0;
				while (true) {
					while (inFlight.length < READ_DEPTH) {
						const bytes = handle.pread(next, length);
						bytes.catch(() => {});
						inFlight.push(bytes);
						next += length;
					}
					const bytes = await inFlight.shift()!;
					if (aborted()) throw abort();
					total += bytes.length;
					if (bytes.length === 0 || total === size || bytes.length !== length) {
						return first ? Buffer.from(bytes).toString("utf8") : text + decoder.end(Buffer.from(bytes));
					}
					text += decoder.write(Buffer.from(bytes));
					first = false;
				}
			} finally {
				await handle.close();
			}
		});
	}

	async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
		return (await this.#readFile(path, true, context)) as Result<string, FileError>;
	}

	async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
		return (await this.#readFile(path, false, context)) as Result<Uint8Array, FileError>;
	}

	async openBinaryReader(
		path: string,
		options: { noFollow?: boolean } | undefined,
		context: Context,
	): Promise<Result<BinaryReader, FileError>> {
		const opened = await this.#fileOp(path, context, async (resolved) => {
			return (await this.#open(resolved, { noFollow: options?.noFollow === true })).handle;
		});
		if (!opened.ok) return opened;
		const aborted = abortResult<BinaryReader>(context.abortSignal, opened.value.path);
		if (aborted) {
			await opened.value.close();
			return aborted;
		}
		return ok(new RemoteBinaryReader(opened.value));
	}

	async openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
		const opened = await this.#fileOp(path, context, async (resolved) => {
			return (await this.#open(resolved, { mode: "read" })).handle;
		});
		if (!opened.ok) return opened;
		const aborted = abortResult<TextLineReader>(context.abortSignal, opened.value.path);
		if (aborted) {
			await opened.value.close();
			return aborted;
		}
		return ok(new RemoteTextLineReader(opened.value));
	}

	async readTextLines(
		path: string,
		options: { maxLines?: number } | undefined,
		context: Context,
	): Promise<Result<string[], FileError>> {
		if (options?.maxLines !== undefined && options.maxLines <= 0) return ok([]);
		const opened = await this.openTextLineReader(path, context);
		if (!opened.ok) return opened;
		const lines: string[] = [];
		try {
			while (options?.maxLines === undefined || lines.length < options.maxLines) {
				const line = await opened.value.readLine(context);
				if (!line.ok) return line;
				if (line.value === undefined) break;
				lines.push(line.value.text);
			}
			return ok(lines);
		} finally {
			await opened.value.close(context);
		}
	}

	/**
	 * 模拟 Node 的 `writeFile`（每写入 512 KiB 前检查中止状态）或 `appendFile`（写入前不检查，完成后检查）：
	 * 第一个请求会创建父目录、打开文件并写入首个数据块；后续数据块写入同一个已打开的文件。
	 */
	async #write(path: string, content: string | Uint8Array, append: boolean, context: Context) {
		const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
		const signal = append ? undefined : context.abortSignal;
		return this.#fileOp(
			path,
			context,
			async (resolved) => {
				const first = bytes.subarray(0, WRITE_CHUNK);
				const keep = bytes.length > WRITE_CHUNK;
				const reply = await this.connection.request("write", { path: resolved, append, keep }, { payload: first });
				if (!keep) return;
				const handle = new Handle(this, reply.json.handle as number, reply.session, resolved);
				const inFlight: Promise<unknown>[] = [];
				try {
					for (let offset = WRITE_CHUNK; offset < bytes.length; offset += WRITE_CHUNK) {
						if (signal?.aborted) {
							// 若某个数据块在此检查前失败，则整个写入失败，与顺序写入时的行为一致。
							const failed = (await Promise.allSettled(inFlight)).find((result) => result.status === "rejected");
							if (failed !== undefined) throw failed.reason;
							throw new FileError("aborted", "The operation was aborted", resolved);
						}
						const written = handle.request(
							"writeChunk",
							{},
							{ payload: bytes.subarray(offset, offset + WRITE_CHUNK) },
						);
						written.catch(() => {});
						inFlight.push(written);
						if (inFlight.length >= WRITE_DEPTH) await inFlight.shift();
					}
					// 等待首个失败结果；守护进程会拒绝后续数据块，因此文件中不会出现缺口。
					for (const written of inFlight) await written;
				} finally {
					await Promise.allSettled(inFlight);
					await handle.close();
				}
			},
			append ? "both" : "before",
		);
	}

	writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		return this.#write(path, content, false, context);
	}

	appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		return this.#write(path, content, true, context);
	}

	async truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
		return this.#fileOp(
			path,
			context,
			async (resolved) => {
				if (!Number.isSafeInteger(size) || size < 0) {
					throw new FileError("invalid", "File size must be a non-negative safe integer", resolved);
				}
				await this.connection.request("truncate", { path: resolved, size });
			},
			"both",
		);
	}

	flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
		return this.#fileOp(
			path,
			context,
			async (resolved) => {
				await this.connection.request("fsync", { path: resolved });
			},
			"both",
		);
	}

	async renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
		let source: string;
		let destination: string;
		try {
			source = await this.#resolve(sourcePath);
			destination = await this.#resolve(destinationPath);
		} catch (error) {
			return err(toFileError(error, sourcePath));
		}
		const aborted = abortResult<void>(context.abortSignal, destination);
		if (aborted) return aborted;
		try {
			await this.connection.request("rename", { path: source, to: destination });
			return ok(undefined);
		} catch (error) {
			return err(toFileError(error, source));
		}
	}

	async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
		const result = await this.#fileOp(path, context, async (resolved) => {
			const { json } = await this.connection.request("lstat", { path: resolved });
			return toInfo(resolved, json as unknown as RemoteFileInfo, await remotePath(this.connection));
		});
		return result.ok ? result.value : result;
	}

	listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
		return this.#fileOp(path, context, async (resolved) => {
			const { handle } = await this.#openDir(resolved);
			const entries: RemoteDirEntry[] = [];
			try {
				for (let done = false; !done; ) {
					const { json } = await handle.request("readdir", { max: 1000 });
					entries.push(...(json.entries as RemoteDirEntry[]));
					done = json.done === true;
				}
			} finally {
				await handle.close();
			}
			// Node 的 `readdir` 遇到无法 lstat 的条目时会失败。POSIX 上的 libuv 按名称字节排序；Windows 上则保留
			// 文件系统返回的顺序，守护进程会报告该顺序。
			const paths = await remotePath(this.connection);
			if (paths === posix) {
				const key = (entry: RemoteDirEntry) => Buffer.from(entry.raw ?? Buffer.from(entry.name, "utf8"));
				entries.sort((a, b) => Buffer.compare(key(a), key(b)));
			}
			const infos: FileInfo[] = [];
			for (const entry of entries) {
				if (context.abortSignal?.aborted) throw new FileError("aborted", "aborted", resolved);
				const entryPath = paths.resolve(resolved, entry.name);
				if (entry.error !== undefined) throw toFileError(new RemoteError(entry.error), entryPath);
				const info = toInfo(entryPath, entry.info!, paths);
				if (info.ok) infos.push(info.value);
			}
			return infos;
		});
	}

	async #openDir(resolved: string): Promise<{ handle: Handle }> {
		const reply = await this.connection.request("opendir", { path: resolved });
		return { handle: new Handle(this, reply.json.handle as number, reply.session, resolved) };
	}

	async openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
		const opened = await this.#fileOp(path, context, async (resolved) => (await this.#openDir(resolved)).handle);
		if (!opened.ok) return opened;
		const aborted = abortResult<DirReader>(context.abortSignal, opened.value.path);
		if (aborted) {
			await opened.value.close();
			return aborted;
		}
		return ok(new RemoteDirReader(opened.value));
	}

	canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
		return this.#fileOp(path, context, async (resolved) => {
			const { json } = await this.connection.request("realpath", { path: resolved });
			return json.path as string;
		});
	}

	async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
		const result = await this.fileInfo(path, context);
		if (result.ok) return ok(true);
		if (result.error.code === "not_found") return ok(false);
		return err(result.error);
	}

	createDir(
		path: string,
		options: { recursive?: boolean } | undefined,
		context: Context,
	): Promise<Result<void, FileError>> {
		return this.#fileOp(path, context, async (resolved) => {
			await this.connection.request("mkdir", { path: resolved, recursive: options?.recursive ?? true });
		});
	}

	remove(
		path: string,
		options: { recursive?: boolean; force?: boolean } | undefined,
		context: Context,
	): Promise<Result<void, FileError>> {
		return this.#fileOp(path, context, async (resolved) => {
			await this.connection.request("rm", {
				path: resolved,
				recursive: options?.recursive ?? false,
				force: options?.force ?? false,
			});
		});
	}

	async createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
		const aborted = abortResult<string>(context.abortSignal);
		if (aborted) return aborted;
		try {
			const { tmpdir } = await this.connection.info();
			const paths = await remotePath(this.connection);
			const { json } = await this.connection.request("mkdtemp", { path: paths.join(tmpdir, prefix ?? "tmp-") });
			return ok(json.path as string);
		} catch (error) {
			return err(toFileError(error));
		}
	}

	async createTempFile(
		options: { prefix?: string; suffix?: string } | undefined,
		context: Context,
	): Promise<Result<string, FileError>> {
		const dir = await this.createTempDir("tmp-", context);
		if (!dir.ok) return dir;
		let filePath = "";
		try {
			const paths = await remotePath(this.connection);
			filePath = paths.join(dir.value, `${options?.prefix ?? ""}${randomUUID()}${options?.suffix ?? ""}`);
			// 模拟 Node 的 `writeFile(filePath, "")` 行为，不创建父目录。
			await this.connection.request(
				"write",
				{ path: filePath, append: false, parents: false },
				{ payload: new Uint8Array(0) },
			);
			return ok(filePath);
		} catch (error) {
			return err(toFileError(error, filePath));
		}
	}

	async watch(
		targets: readonly WatchTarget[],
		onChange: (change: WatchChange) => void,
		context: Context,
	): Promise<Result<FileWatcher, FileError>> {
		const aborted = abortResult<FileWatcher>(context.abortSignal);
		if (aborted) return aborted;
		try {
			const resolved = await Promise.all(
				targets.map(async (target) => ({ ...target, path: await this.#resolve(target.path) })),
			);
			const afterResolve = abortResult<FileWatcher>(context.abortSignal);
			if (afterResolve) return afterResolve;
			const watcher = await RemoteWatcher.open(this.connection, resolved, onChange, this.#watchOptions);
			const afterOpen = abortResult<FileWatcher>(context.abortSignal);
			if (afterOpen) {
				await watcher.close(context);
				return afterOpen;
			}
			return ok(watcher);
		} catch (error) {
			return err(toFileError(error));
		}
	}

	async exec(
		command: string | readonly string[],
		options: ShellExecOptions | undefined,
		context: Context,
	): Promise<Result<ShellExecResult, ExecutionError>> {
		const signal = context.abortSignal;
		if (signal?.aborted) return err(new ExecutionError("aborted", "aborted"));
		const timeout = options?.timeout;
		if (timeout !== undefined) {
			if (!Number.isFinite(timeout) || timeout <= 0) {
				return err(new ExecutionError("timeout", "Invalid timeout: must be a finite number of seconds"));
			}
			if (timeout * 1000 > MAX_TIMEOUT_MS) {
				return err(new ExecutionError("timeout", `Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`));
			}
		}
		const inheritEnv = options?.inheritEnv ?? true;
		let cwd: string;
		try {
			cwd = options?.cwd ? await this.#resolve(options.cwd) : this.cwd;
		} catch (error) {
			return err(new ExecutionError("unknown", error instanceof Error ? error.message : String(error)));
		}
		if (signal?.aborted) return err(new ExecutionError("aborted", "aborted"));
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(
			inheritEnv ? { ...this.#shellEnv, ...options?.env } : { ...options?.env },
		)) {
			if (value !== undefined) env[key.toWellFormed()] = value;
		}
		let callbackError: ExecutionError | undefined;
		let settled = false;
		let running: number | undefined;
		const controller = new AbortController();
		const onAbort = () => controller.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			const { json } = await this.connection.request(
				"exec",
				{
					...(typeof command === "string" ? { command } : { argv: [...command] }),
					cwd,
					env,
					inheritEnv,
					...(this.#shellPath === undefined ? {} : { shellPath: this.#shellPath }),
					...(timeout === undefined ? {} : { timeoutMs: timeout * 1000 }),
					...(options?.spill === undefined ? {} : { spill: options.spill }),
					...(options?.window === undefined ? {} : { window: options.window }),
				},
				{
					signal: controller.signal,
					onStart: (requestId, session) => {
						running = requestId;
						this.#running.set(requestId, session);
					},
					onEvent: (event, payload) => {
						if (settled || callbackError !== undefined || event.kind !== "output") return;
						const text = Buffer.from(payload.buffer, payload.byteOffset, payload.length).toString("utf8");
						if (text === "" || options?.onOutput === undefined) return;
						const info: ShellOutputInfo = { stream: event.stream === "stderr" ? "stderr" : "stdout" };
						if (event.skipped !== undefined) info.skipped = event.skipped as ShellOutputSkip;
						try {
							options.onOutput(text, context, info);
						} catch (error) {
							const cause = error instanceof Error ? error : new Error(String(error));
							callbackError = new ExecutionError("callback_error", cause.message, cause);
							controller.abort();
						}
					},
				},
			);
			if (callbackError) return err(callbackError);
			return ok({
				exitCode: json.exitCode as number,
				...(typeof json.spillPath === "string" ? { spillPath: json.spillPath } : {}),
			});
		} catch (error) {
			if (callbackError) return err(callbackError);
			if (!(error instanceof RemoteError)) {
				return err(new ExecutionError("unknown", error instanceof Error ? error.message : String(error)));
			}
			const failure =
				error.code === "timeout"
					? new ExecutionError("timeout", `timeout:${timeout}`)
					: error.code === "aborted"
						? new ExecutionError("aborted", "aborted")
						: error.code === "shell_unavailable" || error.code === "spawn_error"
							? new ExecutionError(error.code, error.message)
							: new ExecutionError("unknown", error.message);
			if (typeof error.fields.spillPath === "string") failure.spillPath = error.fields.spillPath;
			return err(failure);
		} finally {
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			if (running !== undefined) this.#running.delete(running);
		}
	}

	async cleanup(_context: Context): Promise<void> {
		// 仅结束进程而不发送中止信号，使命令以被结束的状态完成，与 `NodeExecutionEnv` 的行为一致。
		for (const [id, session] of this.#running) this.connection.kill(id, session);
		this.#running.clear();
	}
}

export type { RemoteInfo };
