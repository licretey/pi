/**
 * 截断工具示例 - 展示如何在自定义工具中正确截断输出
 *
 * 自定义工具必须截断输出，避免大段内容占满大语言模型上下文。
 * 内置限制为 50 KB（约 1 万个 token）或 2000 行，以先达到者为准。
 *
 * 本示例展示如何：
 * 1. 使用内置截断工具函数
 * 2. 发生截断时将完整输出写入临时文件
 * 3. 告知大语言模型完整输出的存放位置
 * 4. 自定义工具调用和结果的渲染方式
 *
 * 这里的 `rg` 工具封装了 ripgrep，并实现了正确的输出截断。更完整的实现请参见
 * src/core/tools/grep.ts 中的内置 `grep` 工具。
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationResult,
	truncateHead,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { execSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { Type } from "typebox";

const RgParams = Type.Object({
	pattern: Type.String({ description: "Search pattern (regex)" }),
	path: Type.Optional(Type.String({ description: "Directory to search (default: current directory)" })),
	glob: Type.Optional(Type.String({ description: "File glob pattern, e.g. '*.ts'" })),
});

interface RgDetails {
	pattern: string;
	path?: string;
	glob?: string;
	matchCount: number;
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "rg",
		label: "ripgrep",
		// 在工具描述中说明截断限制，让大语言模型了解
		description: `Search file contents using ripgrep. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} (whichever is hit first). If truncated, full output is saved to a temp file.`,
		parameters: RgParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { pattern, path: searchPath, glob } = params;

			// 构建 ripgrep 命令
			const args = ["rg", "--line-number", "--color=never"];
			if (glob) args.push("--glob", glob);
			args.push(pattern);
			args.push(searchPath || ".");

			let output: string;
			try {
				output = execSync(args.join(" "), {
					cwd: ctx.cwd,
					encoding: "utf-8",
					maxBuffer: 100 * 1024 * 1024, // 100MB buffer to capture full output
				});
			} catch (err: any) {
				// 没有找到匹配项时，ripgrep 会以状态码 1 退出
				if (err.status === 1) {
					return {
						content: [{ type: "text", text: "No matches found" }],
						details: { pattern, path: searchPath, glob, matchCount: 0 } as RgDetails,
					};
				}
				throw new Error(`ripgrep failed: ${err.message}`);
			}

			if (!output.trim()) {
				return {
					content: [{ type: "text", text: "No matches found" }],
					details: { pattern, path: searchPath, glob, matchCount: 0 } as RgDetails,
				};
			}

			// 使用内置工具函数截断输出
			// truncateHead 保留前 N 行或字节（适合搜索结果）
			// truncateTail 保留后 N 行或字节（适合日志或命令输出）
			const truncation = truncateHead(output, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});

			// 统计匹配项数量（每条含匹配内容的非空行计为一项）
			const matchCount = output.split("\n").filter((line) => line.trim()).length;

			const details: RgDetails = {
				pattern,
				path: searchPath,
				glob,
				matchCount,
			};

			let resultText = truncation.content;

			if (truncation.truncated) {
				// 将完整输出保存到临时文件，以便大语言模型在需要时读取
				const tempDir = await mkdtemp(join(tmpdir(), "pi-rg-"));
				const tempFile = join(tempDir, "output.txt");
				await withFileMutationQueue(tempFile, async () => {
					await writeFile(tempFile, output, "utf8");
				});

				details.truncation = truncation;
				details.fullOutputPath = tempFile;

				// 添加截断提示，帮助大语言模型了解输出并不完整
				const truncatedLines = truncation.totalLines - truncation.outputLines;
				const truncatedBytes = truncation.totalBytes - truncation.outputBytes;

				resultText += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
				resultText += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
				resultText += ` ${truncatedLines} lines (${formatSize(truncatedBytes)}) omitted.`;
				resultText += ` Full output saved to: ${tempFile}]`;
			}

			return {
				content: [{ type: "text", text: resultText }],
				details,
			};
		},

		// 自定义工具调用的渲染方式（在执行前和执行期间显示）
		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("rg "));
			text += theme.fg("accent", `"${args.pattern}"`);
			if (args.path) {
				text += theme.fg("muted", ` in ${args.path}`);
			}
			if (args.glob) {
				text += theme.fg("dim", ` --glob ${args.glob}`);
			}
			return new Text(text, 0, 0);
		},

		// 自定义工具结果的渲染方式
		renderResult(result, { expanded, isPartial }, theme, _context) {
			const details = result.details as RgDetails | undefined;

			// 处理流式或部分结果
			if (isPartial) {
				return new Text(theme.fg("warning", "Searching..."), 0, 0);
			}

			// 没有匹配项
			if (!details || details.matchCount === 0) {
				return new Text(theme.fg("dim", "No matches found"), 0, 0);
			}

			// 构建结果显示内容
			let text = theme.fg("success", `${details.matchCount} matches`);

			// 如发生截断，则显示警告
			if (details.truncation?.truncated) {
				text += theme.fg("warning", " (truncated)");
			}

			// 展开视图中显示实际匹配项
			if (expanded) {
				const content = result.content[0];
				if (content?.type === "text") {
					// 展开视图最多显示前 20 行，不足 20 行时全部显示
					const lines = content.text.split("\n").slice(0, 20);
					for (const line of lines) {
						text += `\n${theme.fg("dim", line)}`;
					}
					if (content.text.split("\n").length > 20) {
						text += `\n${theme.fg("muted", "... (use read tool to see full output)")}`;
					}
				}

				// 发生截断时显示临时文件路径
				if (details.fullOutputPath) {
					text += `\n${theme.fg("dim", `Full output: ${details.fullOutputPath}`)}`;
				}
			}

			return new Text(text, 0, 0);
		},
	});
}
