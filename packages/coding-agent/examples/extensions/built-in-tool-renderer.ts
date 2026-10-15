/**
 * 内置工具渲染器示例：自定义内置工具的显示方式。
 *
 * 演示如何自定义内置工具（read、bash、edit、write）的渲染方式，同时不改变其行为。
 * 重新注册每个同名工具，将执行过程委托给原实现，并提供精简的 renderCall/renderResult 函数。
 *
 * 适用于偏好更精简工具输出，或希望突出特定信息的用户（例如 edit 只显示差异统计，或 bash 只显示退出码）。
 *
 * 实现方式：
 * - 使用与内置工具相同的名称调用 registerTool()，即可完全替换该工具。
 * - 通过 createReadToolDefinition() 等函数获取原始定义，只覆盖其渲染器。
 * - renderCall() 控制调用工具时显示的内容。
 * - renderResult() 控制工具执行完成后显示的内容。
 * - 设置 renderShell: "self" 后，工具可以自行渲染外层框，而不使用 ToolExecutionComponent 的默认边框。
 * - renderResult 中的 `expanded` 标志表示用户是否已展开工具输出（通过 ctrl+e 或点击）。
 *
 * 用法：
 *   pi -e ./built-in-tool-renderer.ts
 */

import type { BashToolDetails, EditToolDetails, ExtensionAPI, ReadToolDetails } from "@earendil-works/pi-coding-agent";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();

	// --- Read 工具：显示路径和行数 ---
	const originalRead = createReadToolDefinition(cwd);
	pi.registerTool({
		...originalRead,

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("read "));
			text += theme.fg("accent", args.path);
			if (args.offset || args.limit) {
				const parts: string[] = [];
				if (args.offset) parts.push(`offset=${args.offset}`);
				if (args.limit) parts.push(`limit=${args.limit}`);
				text += theme.fg("dim", ` (${parts.join(", ")})`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, _context) {
			if (isPartial) return new Text(theme.fg("warning", "Reading..."), 0, 0);

			const details = result.details as ReadToolDetails | undefined;
			const content = result.content[0];

			if (content?.type === "image") {
				return new Text(theme.fg("success", "Image loaded"), 0, 0);
			}

			if (content?.type !== "text") {
				return new Text(theme.fg("error", "No content"), 0, 0);
			}

			const lineCount = content.text.split("\n").length;
			let text = theme.fg("success", `${lineCount} lines`);

			if (details?.truncation?.truncated) {
				text += theme.fg("warning", ` (truncated from ${details.truncation.totalLines})`);
			}

			if (expanded) {
				const lines = content.text.split("\n").slice(0, 15);
				for (const line of lines) {
					text += `\n${theme.fg("dim", line)}`;
				}
				if (lineCount > 15) {
					text += `\n${theme.fg("muted", `... ${lineCount - 15} more lines`)}`;
				}
			}

			return new Text(text, 0, 0);
		},
	});

	// --- Bash 工具：显示命令和退出码 ---
	const originalBash = createBashToolDefinition(cwd);
	pi.registerTool({
		...originalBash,

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("$ "));
			const cmd = args.command.length > 80 ? `${args.command.slice(0, 77)}...` : args.command;
			text += theme.fg("accent", cmd);
			if (args.timeout) {
				text += theme.fg("dim", ` (timeout: ${args.timeout}s)`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, _context) {
			if (isPartial) return new Text(theme.fg("warning", "Running..."), 0, 0);

			const details = result.details as BashToolDetails | undefined;
			const content = result.content[0];
			const output = content?.type === "text" ? content.text : "";

			const exitMatch = output.match(/exit code: (\d+)/);
			const exitCode = exitMatch ? parseInt(exitMatch[1], 10) : null;
			const lineCount = output.split("\n").filter((l) => l.trim()).length;

			let text = "";
			if (exitCode === 0 || exitCode === null) {
				text += theme.fg("success", "done");
			} else {
				text += theme.fg("error", `exit ${exitCode}`);
			}
			text += theme.fg("dim", ` (${lineCount} lines)`);

			if (details?.truncation?.truncated) {
				text += theme.fg("warning", " [truncated]");
			}

			if (expanded) {
				const lines = output.split("\n").slice(0, 20);
				for (const line of lines) {
					text += `\n${theme.fg("dim", line)}`;
				}
				if (output.split("\n").length > 20) {
					text += `\n${theme.fg("muted", "... more output")}`;
				}
			}

			return new Text(text, 0, 0);
		},
	});

	// --- Edit 工具：显示路径和差异统计 ---
	const originalEdit = createEditToolDefinition(cwd);
	pi.registerTool({
		...originalEdit,

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("edit "));
			text += theme.fg("accent", args.path);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, _context) {
			if (isPartial) return new Text(theme.fg("warning", "Editing..."), 0, 0);

			const details = result.details as EditToolDetails | undefined;
			const content = result.content[0];

			if (content?.type === "text" && content.text.startsWith("Error")) {
				return new Text(theme.fg("error", content.text.split("\n")[0]), 0, 0);
			}

			if (!details?.diff) {
				return new Text(theme.fg("success", "Applied"), 0, 0);
			}

			// 统计差异中的新增行和删除行。
			const diffLines = details.diff.split("\n");
			let additions = 0;
			let removals = 0;
			for (const line of diffLines) {
				if (line.startsWith("+") && !line.startsWith("+++")) additions++;
				if (line.startsWith("-") && !line.startsWith("---")) removals++;
			}

			let text = theme.fg("success", `+${additions}`);
			text += theme.fg("dim", " / ");
			text += theme.fg("error", `-${removals}`);

			if (expanded) {
				for (const line of diffLines.slice(0, 30)) {
					if (line.startsWith("+") && !line.startsWith("+++")) {
						text += `\n${theme.fg("success", line)}`;
					} else if (line.startsWith("-") && !line.startsWith("---")) {
						text += `\n${theme.fg("error", line)}`;
					} else {
						text += `\n${theme.fg("dim", line)}`;
					}
				}
				if (diffLines.length > 30) {
					text += `\n${theme.fg("muted", `... ${diffLines.length - 30} more diff lines`)}`;
				}
			}

			return new Text(text, 0, 0);
		},
	});

	// --- Write 工具：显示路径和大小 ---
	const originalWrite = createWriteToolDefinition(cwd);
	pi.registerTool({
		...originalWrite,

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("write "));
			text += theme.fg("accent", args.path);
			const lineCount = args.content.split("\n").length;
			text += theme.fg("dim", ` (${lineCount} lines)`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { isPartial }, theme, _context) {
			if (isPartial) return new Text(theme.fg("warning", "Writing..."), 0, 0);

			const content = result.content[0];
			if (content?.type === "text" && content.text.startsWith("Error")) {
				return new Text(theme.fg("error", content.text.split("\n")[0]), 0, 0);
			}

			return new Text(theme.fg("success", "Written"), 0, 0);
		},
	});
}
