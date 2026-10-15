/**
 * codemode 工具的展示逻辑。
 *
 * 调用内容展示脚本；结果展示嵌套工具调用及其运行状态、模型调用费用，随后展示脚本输出，但不包含
 * "Script completed" 标题。嵌套调用不会单独占用工具行，因为它们不会作为工具调用传给模型。
 */

import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import type { ToolDefinition } from "../../core/extensions/types.ts";
import { getTextOutput, replaceTabs, str } from "../../core/tools/render-utils.ts";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import { VisualLinePreview } from "../../modes/interactive/components/visual-truncate.ts";
import { highlightCode, type Theme } from "../../modes/interactive/theme/theme.ts";
import type { CodemodeNestedCall, CodemodeToolDetails } from "./tool.ts";

const CODE_PREVIEW_LINES = 10;
const CALL_PREVIEW_COUNT = 8;
const OUTPUT_PREVIEW_LINES = 5;
const COLLAPSED_ARGS_CHARS = 80;
const SCRIPT_HEADER = /^Script (completed|failed)\nWall time [\d.]+ seconds\nOutput:\n$/;

function expandHint(theme: Theme, hidden: number, noun: string): string {
	return `${theme.fg("muted", `... (${hidden} more ${noun},`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
}

function formatDuration(ms: number | undefined): string {
	if (ms === undefined) return "";
	return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** 较大金额按美分显示；分类器调用费用不足一美分时保留两位有效数字。 */
function formatCost(cost: number): string {
	return `$${cost >= 0.01 ? cost.toFixed(2) : cost.toPrecision(2)}`;
}

function statusIcon(call: CodemodeNestedCall, theme: Theme): string {
	switch (call.status) {
		case "running":
			return theme.fg("warning", "…");
		case "ok":
			return theme.fg("success", "✓");
		case "error":
			return theme.fg("error", "✗");
		case "cancelled":
			return theme.fg("muted", "⊘");
	}
}

function formatCall(call: CodemodeNestedCall, theme: Theme, expanded: boolean): string {
	const args =
		!expanded && call.args.length > COLLAPSED_ARGS_CHARS
			? `${call.args.slice(0, COLLAPSED_ARGS_CHARS - 3)}...`
			: call.args;
	const duration = formatDuration(call.durationMs);
	let line = `${statusIcon(call, theme)} ${theme.fg("toolTitle", call.name)}`;
	if (args) line += ` ${theme.fg("muted", args)}`;
	if (duration) line += ` ${theme.fg("dim", duration)}`;
	if (call.cost) line += ` ${theme.fg("dim", formatCost(call.cost))}`;
	if (expanded && call.error) line += `\n    ${theme.fg("error", call.error.split("\n").join("\n    "))}`;
	return line;
}

export const codemodeRenderers: Pick<
	ToolDefinition<any, CodemodeToolDetails | undefined>,
	"renderCall" | "renderResult"
> = {
	renderCall(args, theme, context) {
		// 代码中包含 `// @options:` 行，因此选项也会作为脚本的一部分显示。
		const code = str((args as { code?: unknown } | undefined)?.code);
		const title = theme.fg("toolTitle", theme.bold("codemode"));
		const component = (context.lastComponent as Container | undefined) ?? new Container();
		component.clear();
		if (code === null) {
			component.addChild(new Text(`${title} ${theme.fg("error", "[invalid arg]")}`, 0, 0));
			return component;
		}
		component.addChild(new Text(title, 0, 0));
		if (code) {
			const highlighted = highlightCode(replaceTabs(code.replace(/\r/g, "").trimEnd()), "javascript").join("\n");
			component.addChild(
				context.expanded
					? new Text(highlighted, 0, 0)
					: new VisualLinePreview({
							text: highlighted,
							maxVisualLines: CODE_PREVIEW_LINES,
							keep: "start",
							formatHint: (hidden) => expandHint(theme, hidden, "lines"),
						}),
			);
		}
		return component;
	},
	renderResult(result, options, theme, context) {
		const component = (context.lastComponent as Container | undefined) ?? new Container();
		component.clear();
		const calls = result.details?.calls ?? [];
		if (calls.length > 0) {
			const shown = options.expanded ? calls : calls.slice(-CALL_PREVIEW_COUNT);
			const lines = shown.map((call) => formatCall(call, theme, options.expanded));
			if (shown.length < calls.length) {
				lines.unshift(
					`${theme.fg("muted", `... (${calls.length - shown.length} earlier calls,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`,
				);
			}
			// 折叠行会隐藏较早的调用，因此总数需包含所有调用。
			const priced = calls.filter((call) => call.cost);
			if (priced.length > 1) {
				const total = priced.reduce((sum, call) => sum + (call.cost ?? 0), 0);
				lines.push(theme.fg("muted", `Model calls: ${formatCost(total)}`));
			}
			component.addChild(new Spacer(1));
			component.addChild(new Text(lines.join("\n"), 0, 0));
		}

		// 移除 "Script completed\nWall time ...\nOutput:\n" 标题。输入被拒绝（选项无效）时不会有标题。
		const [first, ...rest] = result.content;
		const hasHeader = first?.type === "text" && SCRIPT_HEADER.test(first.text);
		const output = options.isPartial
			? ""
			: getTextOutput({ ...result, content: hasHeader ? rest : result.content }, context.showImages).trim();
		if (output) {
			const color = context.isError ? "error" : "toolOutput";
			const styled = replaceTabs(output)
				.split("\n")
				.map((line) => theme.fg(color, line))
				.join("\n");
			component.addChild(new Spacer(1));
			if (options.expanded) {
				component.addChild(new Text(styled, 0, 0));
			} else {
				// 限制折行后的行数，而非逻辑行数：脚本输出常常是一整行很长的 JSON。
				component.addChild(
					new VisualLinePreview({
						text: styled,
						maxVisualLines: OUTPUT_PREVIEW_LINES,
						keep: "start",
						formatHint: (hidden) => expandHint(theme, hidden, "lines"),
					}),
				);
				// 折叠预览会隐藏末尾的截断提示，因此在这里注明文件名。
				const fullOutputPath = result.details?.fullOutputPath;
				if (fullOutputPath) component.addChild(new Text(theme.fg("muted", `Full output: ${fullOutputPath}`), 0, 0));
			}
		}
		return component;
	},
};
