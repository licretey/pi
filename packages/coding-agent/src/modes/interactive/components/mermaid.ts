import { Marked, type Token } from "@earendil-works/pi-tui";
import { type MermaidArt, render, type Span } from "grok-mermaid";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import type { MermaidRenderingMode } from "../../../core/settings-manager.ts";
import type { Theme } from "../theme/theme.ts";

const markdownParser = new Marked();

interface MermaidTransformerOptions {
	getMode: () => MermaidRenderingMode;
	theme?: Theme;
}

function isMermaid(token: Token): token is Token & { type: "code"; text: string; lang?: string } {
	return token.type === "code" && token.lang?.trim().split(/\s+/, 1)[0]?.toLowerCase() === "mermaid";
}

function codeSpan(line: string): string {
	// 将图表的每一行编码为行内代码（` ... `），以便 Markdown 保留空格和
	// 制表字符。空行使用不换行空格，因为空的代码片段
	// 不会产生可见高度。
	const content = line || "\u00a0";
	// CommonMark 的代码片段使用成对的反引号作为定界符，因此选择比内容中
	// 最长反引号序列多一个反引号的定界符（``hel`lo`` -> <code>hel`lo</code>）。
	// 如果内容以反引号开头或结尾，则在内容与定界符之间加入空格，
	// 以确保该反引号仍属于内容；CommonMark 渲染时会移除
	// 这些填充空格（`` `edge` `` -> <code>`edge`</code>）。
	// Mermaid 标签可以保留反引号，例如：
	//   `┌──────────────┐    ┌──────────────┐`
	// ```│ plain ` tick ├───▶│ two `` ticks │```
	//   `└──────────────┘    └──────────────┘`
	const longestBacktickRun = Math.max(0, ...Array.from(content.matchAll(/`+/g), (match) => match[0].length));
	const fence = "`".repeat(longestBacktickRun + 1);
	const padding = content.startsWith("`") || content.endsWith("`") ? " " : "";
	return `${fence}${padding}${content}${padding}${fence}`;
}

function styleSpan(span: Span, theme: Theme): string {
	switch (span.cls) {
		case "border":
			return theme.fg("borderMuted", span.text);
		case "text":
			return theme.fg("text", span.text);
		case "edge":
			return theme.fg("accent", span.text);
		case "edgeLabel":
			return theme.fg("muted", span.text);
		case "title":
			return theme.fg("accent", theme.bold(span.text));
		case "none":
			return span.text;
	}
}

function themedLines(art: MermaidArt, theme: Theme): string[] {
	return art.styled.map((row) => row.map((span) => styleSpan(span, theme)).join(""));
}

/** 创建转换器，将顶层 Mermaid 代码块替换为 Unicode 终端图表。 */
export function createMermaidMarkdownTransformer(options: MermaidTransformerOptions): MarkdownTransformer {
	return (markdown, context) => {
		const mode = options.getMode();
		if (
			mode === "off" ||
			context.messageType === "assistant-thinking" ||
			(context.isStreaming && mode !== "streaming")
		) {
			return markdown;
		}

		return markdownParser
			.lexer(markdown)
			.map((token) => {
				if (!isMermaid(token)) return token.raw;
				const art = render(token.text);
				if (!art || art.width > context.availableWidth) return token.raw;
				if (!context.isStreaming && art.warnings.length > 0) {
					const suffix = art.warnings.length > 1 ? ` (+${art.warnings.length - 1} more)` : "";
					const warning = `Mermaid diagram not rendered: ${art.warnings[0]}${suffix}`;
					const styledWarning = options.theme ? options.theme.fg("warning", warning) : warning;
					return `${token.raw}\n${codeSpan(styledWarning)}  \n`;
				}
				const lines = options.theme ? themedLines(art, options.theme) : art.plain;
				// Markdown 硬换行可确保图表的每一行各占一行。
				return `${lines.map(codeSpan).join("  \n")}\n`;
			})
			.join("");
	};
}
