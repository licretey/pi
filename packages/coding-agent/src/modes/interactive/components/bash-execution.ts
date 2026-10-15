/**
 * 显示 Bash 命令执行及其流式输出的组件。
 */

import { Container, Loader, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type TruncationResult,
	truncateTail,
} from "../../../core/tools/truncate.ts";
import { stripAnsi } from "../../../utils/ansi.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, keyText } from "./keybinding-hints.ts";
import { truncateToVisualLines } from "./visual-truncate.ts";

// 折叠时的预览行数上限（与工具执行结果的显示行为一致）。
const PREVIEW_LINES = 20;

export class BashExecutionComponent extends Container {
	private command: string;
	private outputLines: string[] = [];
	private status: "running" | "complete" | "cancelled" | "error" = "running";
	private exitCode: number | undefined = undefined;
	private loader: Loader;
	private truncationResult?: TruncationResult;
	private fullOutputPath?: string;
	private expanded = false;
	private contentContainer: Container;
	/** 使用 `dim` 标记以 `!!` 开头的命令；这类命令的输出会从模型上下文中排除。 */
	private readonly colorKey: "dim" | "bashMode";
	private outputPad: number;

	constructor(command: string, ui: TUI, excludeFromContext = false, outputPad = 1) {
		super();
		this.command = command;
		this.colorKey = excludeFromContext ? "dim" : "bashMode";
		this.outputPad = outputPad;
		const borderColor = (str: string) => theme.fg(this.colorKey, str);

		// 添加间隔。
		this.addChild(new Spacer(1));

		// 上边框。
		this.addChild(new DynamicBorder(borderColor));

		// 内容容器（用于放置边框之间的动态内容）。
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		this.loader = new Loader(
			ui,
			(spinner) => theme.fg(this.colorKey, spinner),
			(text) => theme.fg("muted", text),
			`Running... (${keyText("tui.select.cancel")} to cancel)`, // 加载指示器使用纯文本。
		);

		// 下边框。
		this.addChild(new DynamicBorder(borderColor));

		this.updateDisplay();
	}

	/**
	 * 设置输出是否展开（显示完整内容）或折叠（仅显示预览）。
	 */
	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	setOutputPad(outputPad: number): void {
		this.outputPad = outputPad;
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	appendOutput(chunk: string): void {
		// 移除 ANSI 控制码并统一换行符。
		// 注意：二进制数据已在 tui-renderer.ts 的 executeBashCommand 中清理。
		const clean = stripAnsi(chunk).replace(/\r\n/g, "\n").replace(/\r/g, "\n");

		// 追加到输出行。
		const newLines = clean.split("\n");
		if (this.outputLines.length > 0 && newLines.length > 0) {
			// 将首个数据块追加到上一行（续接尚未完成的行）。
			this.outputLines[this.outputLines.length - 1] += newLines[0];
			this.outputLines.push(...newLines.slice(1));
		} else {
			this.outputLines.push(...newLines);
		}

		this.updateDisplay();
	}

	setComplete(
		exitCode: number | undefined,
		cancelled: boolean,
		truncationResult?: TruncationResult,
		fullOutputPath?: string,
	): void {
		this.exitCode = exitCode;
		this.status = cancelled
			? "cancelled"
			: exitCode !== 0 && exitCode !== undefined && exitCode !== null
				? "error"
				: "complete";
		this.truncationResult = truncationResult;
		this.fullOutputPath = fullOutputPath;

		// 停止加载指示器。
		this.loader.stop();

		this.updateDisplay();
	}

	private updateDisplay(): void {
		// 按 LLM 上下文限制截断（与 Bash 工具使用相同的限制）。
		const fullOutput = this.outputLines.join("\n");
		const contextTruncation = truncateTail(fullOutput, {
			maxLines: DEFAULT_MAX_LINES,
			maxBytes: DEFAULT_MAX_BYTES,
		});

		// 获取待显示的行（已按上下文限制截断）。
		const availableLines = contextTruncation.content ? contextTruncation.content.split("\n") : [];

		// 根据展开状态截断预览内容。
		const previewLogicalLines = availableLines.slice(-PREVIEW_LINES);
		const hiddenLineCount = availableLines.length - previewLogicalLines.length;

		// 重建内容容器。
		this.contentContainer.clear();

		// 命令标题。
		const header = new Text(theme.fg(this.colorKey, theme.bold(`$ ${this.command}`)), this.outputPad, 0);
		this.contentContainer.addChild(header);

		// 输出内容。
		if (availableLines.length > 0) {
			if (this.expanded) {
				// 显示所有行。
				const displayText = availableLines.map((line) => theme.fg("muted", line)).join("\n");
				this.contentContainer.addChild(new Text(`\n${displayText}`, this.outputPad, 0));
			} else {
				// 使用共享的视觉截断工具，并按宽度缓存结果。
				const styledOutput = previewLogicalLines.map((line) => theme.fg("muted", line)).join("\n");
				const styledInput = `\n${styledOutput}`;
				let cachedWidth: number | undefined;
				let cachedLines: string[] | undefined;
				this.contentContainer.addChild({
					render: (width: number) => {
						if (cachedLines === undefined || cachedWidth !== width) {
							const result = truncateToVisualLines(styledInput, PREVIEW_LINES, width, this.outputPad);
							cachedLines = result.visualLines;
							cachedWidth = width;
						}
						return cachedLines ?? [];
					},
					invalidate: () => {
						cachedWidth = undefined;
						cachedLines = undefined;
					},
				});
			}
		}

		// 加载指示器或状态。
		if (this.status === "running") {
			this.contentContainer.addChild(this.loader);
		} else {
			const statusParts: string[] = [];

			// 显示折叠预览中隐藏的行数。
			if (hiddenLineCount > 0) {
				if (this.expanded) {
					statusParts.push(
						`${theme.fg("muted", "(")}${keyHint("app.tools.expand", "to collapse")}${theme.fg("muted", ")")}`,
					);
				} else {
					statusParts.push(
						`${theme.fg("muted", `... ${hiddenLineCount} more lines (`)}${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`,
					);
				}
			}

			if (this.status === "cancelled") {
				statusParts.push(theme.fg("warning", "(cancelled)"));
			} else if (this.status === "error") {
				statusParts.push(theme.fg("error", `(exit ${this.exitCode})`));
			}

			// 添加截断警告（指上下文截断，而非预览截断）。
			const wasTruncated = this.truncationResult?.truncated || contextTruncation.truncated;
			if (wasTruncated && this.fullOutputPath) {
				statusParts.push(theme.fg("warning", `Output truncated. Full output: ${this.fullOutputPath}`));
			}

			if (statusParts.length > 0) {
				this.contentContainer.addChild(new Text(`\n${statusParts.join("\n")}`, this.outputPad, 0));
			}
		}
	}

	/**
	 * 获取用于创建 BashExecutionMessage 的原始输出。
	 */
	getOutput(): string {
		return this.outputLines.join("\n");
	}

	/**
	 * 获取已执行的命令。
	 */
	getCommand(): string {
		return this.command;
	}
}
