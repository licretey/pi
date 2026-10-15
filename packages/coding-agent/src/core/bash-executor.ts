/**
 * 支持流式输出和中止操作的 Bash 命令执行。
 *
 * 本模块提供统一的 Bash 执行实现，供以下场景使用：
 * - 交互模式和 RPC 模式中的 AgentSession.executeBash()
 * - 需要执行 Bash 命令的模式直接调用
 */

import type { WriteStream } from "node:fs";
import { splitIncompleteAnsiSuffix, stripAnsi } from "../utils/ansi.ts";
import { createOutputFileStream } from "../utils/output-files.ts";
import { sanitizeBinaryOutput } from "../utils/shell.ts";
import type { BashOperations } from "./tools/bash.ts";
import { DEFAULT_MAX_BYTES, truncateTail } from "./tools/truncate.ts";

// ============================================================================
// 类型
// ============================================================================

export interface BashExecutorOptions {
	/** 流式输出数据块的回调（内容已清理）。 */
	onChunk?: (chunk: string) => void;
	/** 用于中止操作的 AbortSignal。 */
	signal?: AbortSignal;
}

export interface BashResult {
	/** 合并后的 stdout 和 stderr 输出（已清理，可能已截断）。 */
	output: string;
	/** 进程退出码（被终止或取消时为 undefined）。 */
	exitCode: number | undefined;
	/** 命令是否因 signal 而取消。 */
	cancelled: boolean;
	/** 输出是否已截断。 */
	truncated: boolean;
	/** 完整输出临时文件的路径（输出超过截断阈值时提供）。 */
	fullOutputPath?: string;
}

// ============================================================================
// 实现
// ============================================================================

/**
 * 使用自定义 BashOperations 执行 Bash 命令。
 * 用于远程执行场景（SSH、容器等）。
 */
export async function executeBashWithOperations(
	command: string,
	cwd: string,
	operations: BashOperations,
	options?: BashExecutorOptions,
): Promise<BashResult> {
	const outputChunks: string[] = [];
	let outputBytes = 0;
	const maxOutputBytes = DEFAULT_MAX_BYTES * 2;

	let tempFilePath: string | undefined;
	let tempFileStream: WriteStream | undefined;
	let totalBytes = 0;

	const ensureTempFile = () => {
		if (tempFilePath) {
			return;
		}
		({ path: tempFilePath, stream: tempFileStream } = createOutputFileStream("pi-bash", ".log"));
		for (const chunk of outputChunks) {
			tempFileStream.write(chunk);
		}
	};

	const decoder = new TextDecoder();
	// 上一个数据块末尾未完成的转义序列，等待下一个数据块补全。
	let pendingAnsi = "";

	const appendText = (rawText: string) => {
		// 清理输出：移除 ANSI 序列、替换二进制乱码并规范换行符。
		const text = sanitizeBinaryOutput(stripAnsi(rawText)).replace(/\r/g, "");
		if (!text) {
			return;
		}

		// 超过阈值后开始写入临时文件。
		if (totalBytes > DEFAULT_MAX_BYTES) {
			ensureTempFile();
		}

		if (tempFileStream) {
			tempFileStream.write(text);
		}

		// 保留滚动缓冲区。
		outputChunks.push(text);
		outputBytes += text.length;
		while (outputBytes > maxOutputBytes && outputChunks.length > 1) {
			const removed = outputChunks.shift()!;
			outputBytes -= removed.length;
		}

		// 将数据块传给回调。
		if (options?.onChunk) {
			options.onChunk(text);
		}
	};

	const onData = (data: Buffer) => {
		totalBytes += data.length;
		const { complete, pending } = splitIncompleteAnsiSuffix(pendingAnsi + decoder.decode(data, { stream: true }));
		pendingAnsi = pending;
		appendText(complete);
	};

	const flushOutput = () => {
		const rest = pendingAnsi + decoder.decode();
		pendingAnsi = "";
		appendText(rest);
	};

	let exitCode: number | null = null;
	try {
		({ exitCode } = await operations.exec(command, cwd, { onData, signal: options?.signal }));
	} catch (err) {
		// 命令被中止时仍会返回此前已产生的输出。
		if (!options?.signal?.aborted) {
			tempFileStream?.end();
			throw err;
		}
	}

	flushOutput();
	const fullOutput = outputChunks.join("");
	const truncationResult = truncateTail(fullOutput);
	if (truncationResult.truncated) {
		ensureTempFile();
	}
	tempFileStream?.end();
	const cancelled = options?.signal?.aborted ?? false;

	return {
		output: truncationResult.truncated ? truncationResult.content : fullOutput,
		exitCode: cancelled ? undefined : (exitCode ?? undefined),
		cancelled,
		truncated: truncationResult.truncated,
		fullOutputPath: tempFilePath,
	};
}
