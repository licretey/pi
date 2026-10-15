import { Box, Container, Markdown, type MarkdownTheme, MouseRegion, Text } from "@earendil-works/pi-tui";
import type { ParsedSkillBlock } from "../../../core/agent-session.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { keyText } from "./keybinding-hints.ts";

/**
 * 用于呈现可折叠或展开的技能调用消息。
 * 背景色与自定义消息相同，以保持视觉一致。
 * 这里只呈现技能内容块；用户消息由其他组件单独呈现。
 */
export class SkillInvocationMessageComponent extends Box {
	private expanded = false;
	private skillBlock: ParsedSkillBlock;
	private markdownTheme: MarkdownTheme;

	constructor(skillBlock: ParsedSkillBlock, markdownTheme: MarkdownTheme = getMarkdownTheme(), outputPad = 1) {
		super(outputPad, 1, (t) => theme.bg("customMessageBg", t));
		this.skillBlock = skillBlock;
		this.markdownTheme = markdownTheme;
		this.updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	setOutputPad(outputPad: number): void {
		this.setPaddingX(outputPad);
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	private updateDisplay(): void {
		this.clear();
		const content = new Container();

		if (this.expanded) {
			// 展开状态：标签、技能名称标题和完整内容。
			const label = theme.fg("customMessageLabel", `\x1b[1m[skill]\x1b[22m`);
			content.addChild(new Text(label, 0, 0));
			const header = `**${this.skillBlock.name}**\n\n`;
			content.addChild(
				new Markdown(header + this.skillBlock.content, 0, 0, this.markdownTheme, {
					color: (text: string) => theme.fg("customMessageText", text),
				}),
			);
		} else {
			// 折叠状态：单行显示 [skill] 名称（提示可展开）。
			const line =
				theme.fg("customMessageLabel", `\x1b[1m[skill]\x1b[22m `) +
				theme.fg("customMessageText", this.skillBlock.name) +
				theme.fg("dim", ` (${keyText("app.tools.expand")} to expand)`);
			content.addChild(new Text(line, 0, 0));
		}

		this.addChild(
			new MouseRegion(content, (event) => {
				if (event.type !== "click" || event.button !== "left") return undefined;
				this.setExpanded(!this.expanded);
				return { handled: true };
			}),
		);
	}
}
