/**
 * 输出文件：pi 写入的文件，用于让模型访问未完整展示给它的内容，例如被截断的工具输出全文、
 * 二进制 MCP 资源，以及 codemode 脚本展示的图像。
 * 所有输出文件都在此处创建，因此存储位置只需在一处修改。目前文件会写入操作系统临时目录。
 */

import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 输出文件可能包含私密数据，因此只有用户可以读取。 */
const OUTPUT_FILE_MODE = 0o600;

/** 尚未使用的新路径：`<dir>/<prefix>-<random hex><extension>`。`extension` 包含点号。 */
function createOutputFilePath(prefix: string, extension: string): string {
	return join(tmpdir(), `${prefix}-${randomBytes(8).toString("hex")}${extension}`);
}

/** 将 `data` 写入新的输出文件并返回其路径。 */
export async function writeOutputFile(prefix: string, extension: string, data: string | Uint8Array): Promise<string> {
	const path = createOutputFilePath(prefix, extension);
	// `wx` 不会跟随他人预先放置在该路径上的链接。
	await writeFile(path, data, { mode: OUTPUT_FILE_MODE, flag: "wx" });
	return path;
}

/** 打开新的输出文件，以便流式写入内容。 */
export function createOutputFileStream(prefix: string, extension: string): { path: string; stream: WriteStream } {
	const path = createOutputFilePath(prefix, extension);
	return { path, stream: createWriteStream(path, { mode: OUTPUT_FILE_MODE, flags: "wx" }) };
}
