/**
 * 工具覆盖示例：演示如何覆盖内置工具。
 *
 * 扩展可以注册与内置工具同名的工具，从而替换内置工具。
 * 适用于以下场景：
 * - 为工具调用添加日志或审计。
 * - 实现访问控制或沙箱隔离。
 * - 将工具调用路由到远程系统（例如 pi-ssh-remote）。
 * - 根据特定工作流修改工具行为。
 *
 * 此示例覆盖 `read` 工具，以便：
 * 1. 将所有文件访问记录到日志文件。
 * 2. 阻止访问敏感路径（例如 .env 文件）。
 * 3. 对允许访问的文件委托给原始 read 实现。
 *
 * 由于没有提供自定义 renderCall/renderResult，会自动使用内置渲染器
 *（提供语法高亮、行号和截断警告）。
 *
 * 用法：
 *   pi -e ./tool-override.ts
 */

import type { TextContent } from "@earendil-works/pi-ai";
import { type ExtensionAPI, getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { constants, readFileSync } from "fs";
import { access, appendFile, readFile } from "fs/promises";
import { join, resolve } from "path";
import { Type } from "typebox";

const LOG_FILE = join(getAgentDir(), "read-access.log");

// 禁止读取的路径模式。
const BLOCKED_PATTERNS = [
	/\.env$/,
	/\.env\..+$/,
	/secrets?\.(json|yaml|yml|toml)$/i,
	/credentials?\.(json|yaml|yml|toml)$/i,
	/\/\.ssh\//,
	/\/\.aws\//,
	/\/\.gnupg\//,
];

function isBlockedPath(path: string): boolean {
	return BLOCKED_PATTERNS.some((pattern) => pattern.test(path));
}

async function logAccess(path: string, allowed: boolean, reason?: string) {
	const timestamp = new Date().toISOString();
	const status = allowed ? "ALLOWED" : "BLOCKED";
	const msg = reason ? ` (${reason})` : "";
	const line = `[${timestamp}] ${status}: ${path}${msg}\n`;

	try {
		await withFileMutationQueue(LOG_FILE, async () => {
			await appendFile(LOG_FILE, line);
		});
	} catch {
		// 忽略日志记录错误。
	}
}

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "read", // 与内置工具同名，因此会覆盖它。
		label: "read (audited)",
		description:
			"Read the contents of a file with access logging. Some sensitive paths (.env, secrets, credentials) are blocked.",
		parameters: readSchema,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { path, offset, limit } = params;
			const absolutePath = resolve(ctx.cwd, path);

			// 检查路径是否被禁止访问。
			if (isBlockedPath(absolutePath)) {
				await logAccess(absolutePath, false, "matches blocked pattern");
				return {
					content: [
						{
							type: "text",
							text: `Access denied: "${path}" matches a blocked pattern (sensitive file). This tool blocks access to .env files, secrets, credentials, and SSH/AWS/GPG directories.`,
						},
					],
					details: { blocked: true },
				};
			}

			// 记录获准的访问。
			await logAccess(absolutePath, true);

			// 执行实际读取（简化实现）。
			try {
				await access(absolutePath, constants.R_OK);
				const content = await readFile(absolutePath, "utf-8");
				const lines = content.split("\n");

				// 应用 offset 和 limit。
				const startLine = offset ? Math.max(0, offset - 1) : 0;
				const endLine = limit ? startLine + limit : lines.length;
				const selectedLines = lines.slice(startLine, endLine);

				// 基本截断处理（上限为 50 KB）。
				let text = selectedLines.join("\n");
				const maxBytes = 50 * 1024;
				if (Buffer.byteLength(text, "utf-8") > maxBytes) {
					text = `${text.slice(0, maxBytes)}\n\n[Output truncated at 50KB]`;
				}

				return {
					content: [{ type: "text", text }] as TextContent[],
					details: { lines: lines.length },
				};
			} catch (error: any) {
				return {
					content: [{ type: "text", text: `Error reading file: ${error.message}` }] as TextContent[],
					details: { error: true },
				};
			}
		},

		// 未定义 renderCall/renderResult，因此会自动使用内置渲染器
		//（语法高亮、行号、截断警告等）。
	});

	// 另外注册一个用于查看访问日志的命令。
	pi.registerCommand("read-log", {
		description: "View the file access log",
		handler: async (_args, ctx) => {
			try {
				const log = readFileSync(LOG_FILE, "utf-8");
				const lines = log.trim().split("\n").slice(-20); // 最近 20 条记录。
				ctx.ui.notify(`Recent file access:\n${lines.join("\n")}`, "info");
			} catch {
				ctx.ui.notify("No access log found", "info");
			}
		},
	});
}
