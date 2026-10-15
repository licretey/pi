/**
 * 将命令行中的 @file 参数处理为文本内容和图像附件。
 */

import { access, readFile, stat } from "node:fs/promises";
import type { ImageContent } from "@earendil-works/pi-ai";
import chalk from "chalk";
import { resolve } from "path";
import { resolveReadPath } from "../core/tools/path-utils.ts";
import { processImage } from "../utils/image-process.ts";
import { detectSupportedImageMimeTypeFromFile } from "../utils/mime.ts";
import { stripBom } from "../utils/text.ts";

export interface ProcessedFiles {
	text: string;
	images: ImageContent[];
}

export interface ProcessFileOptions {
	/** 是否自动缩放图像。默认值：true。 */
	autoResizeImages?: boolean;
}

/** 将 @file 参数处理为文本内容和图像附件。 */
export async function processFileArguments(fileArgs: string[], options?: ProcessFileOptions): Promise<ProcessedFiles> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	let text = "";
	const images: ImageContent[] = [];

	for (const fileArg of fileArgs) {
		// 展开并解析路径（处理 ~ 展开和 macOS 截图路径中的 Unicode 空格）。
		const absolutePath = resolve(resolveReadPath(fileArg, process.cwd()));

		// 检查文件是否存在。
		try {
			await access(absolutePath);
		} catch {
			console.error(chalk.red(`Error: File not found: ${absolutePath}`));
			process.exit(1);
		}

		// 检查文件是否为空。
		const stats = await stat(absolutePath);
		if (stats.size === 0) {
			// 跳过空文件。
			continue;
		}

		const mimeType = await detectSupportedImageMimeTypeFromFile(absolutePath);

		if (mimeType) {
			// 处理图像文件。
			const content = await readFile(absolutePath);
			const processed = await processImage(content, mimeType, { autoResizeImages });

			if (!processed.ok) {
				text += `<file name="${absolutePath}">${processed.message}</file>\n`;
				continue;
			}

			const attachment: ImageContent = {
				type: "image",
				mimeType: processed.mimeType,
				data: processed.data,
			};
			images.push(attachment);

			// 添加图像的文本引用，以及可选的处理提示。
			if (processed.hints.length > 0) {
				text += `<file name="${absolutePath}">${processed.hints.join("\n")}</file>\n`;
			} else {
				text += `<file name="${absolutePath}"></file>\n`;
			}
		} else {
			// 处理文本文件。
			try {
				const content = stripBom(await readFile(absolutePath, "utf-8"));
				text += `<file name="${absolutePath}">\n${content}\n</file>\n`;
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(chalk.red(`Error: Could not read file ${absolutePath}: ${message}`));
				process.exit(1);
			}
		}
	}

	return { text, images };
}
