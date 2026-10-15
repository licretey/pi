/**
 * 将 ANSI 转义码转换为 HTML。
 *
 * 将终端 ANSI 颜色和样式码转换为带内联样式的 HTML。
 * 支持：
 * - 标准前景色（30-37）及亮色变体（90-97）
 * - 标准背景色（40-47）及亮色变体（100-107）
 * - 256 色调色板（38;5;N 和 48;5;N）
 * - RGB 真彩色（38;2;R;G;B 和 48;2;R;G;B）
 * - 文本样式：粗体（1）、淡化（2）、斜体（3）、下划线（4）
 * - 重置（0）
 */

// 标准 ANSI 调色板（0-15）。
const ANSI_COLORS = [
	"#000000", // 0：黑色
	"#800000", // 1：红色
	"#008000", // 2：绿色
	"#808000", // 3：黄色
	"#000080", // 4：蓝色
	"#800080", // 5：洋红色
	"#008080", // 6：青色
	"#c0c0c0", // 7：白色
	"#808080", // 8：亮黑色
	"#ff0000", // 9：亮红色
	"#00ff00", // 10：亮绿色
	"#ffff00", // 11：亮黄色
	"#0000ff", // 12：亮蓝色
	"#ff00ff", // 13：亮洋红色
	"#00ffff", // 14：亮青色
	"#ffffff", // 15：亮白色
];

/**
 * 将 256 色索引转换为十六进制颜色值。
 */
function color256ToHex(index: number): string {
	// 标准颜色（0-15）。
	if (index < 16) {
		return ANSI_COLORS[index];
	}

	// 色彩立方体（16-231）：6×6×6，共 216 种颜色。
	if (index < 232) {
		const cubeIndex = index - 16;
		const r = Math.floor(cubeIndex / 36);
		const g = Math.floor((cubeIndex % 36) / 6);
		const b = cubeIndex % 6;
		const toComponent = (n: number) => (n === 0 ? 0 : 55 + n * 40);
		const toHex = (n: number) => toComponent(n).toString(16).padStart(2, "0");
		return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
	}

	// 灰度（232-255）：24 个色阶。
	const gray = 8 + (index - 232) * 10;
	const grayHex = gray.toString(16).padStart(2, "0");
	return `#${grayHex}${grayHex}${grayHex}`;
}

/**
 * 转义 HTML 特殊字符。
 */
function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

interface TextStyle {
	fg: string | null;
	bg: string | null;
	bold: boolean;
	dim: boolean;
	italic: boolean;
	underline: boolean;
}

function createEmptyStyle(): TextStyle {
	return {
		fg: null,
		bg: null,
		bold: false,
		dim: false,
		italic: false,
		underline: false,
	};
}

function styleToInlineCSS(style: TextStyle): string {
	const parts: string[] = [];
	if (style.fg) parts.push(`color:${style.fg}`);
	if (style.bg) parts.push(`background-color:${style.bg}`);
	if (style.bold) parts.push("font-weight:bold");
	if (style.dim) parts.push("opacity:0.6");
	if (style.italic) parts.push("font-style:italic");
	if (style.underline) parts.push("text-decoration:underline");
	return parts.join(";");
}

function hasStyle(style: TextStyle): boolean {
	return style.fg !== null || style.bg !== null || style.bold || style.dim || style.italic || style.underline;
}

/**
 * 解析 ANSI SGR（选择图形再现）码并更新样式。
 */
function applySgrCode(params: number[], style: TextStyle): void {
	let i = 0;
	while (i < params.length) {
		const code = params[i];

		if (code === 0) {
			// 重置所有样式。
			style.fg = null;
			style.bg = null;
			style.bold = false;
			style.dim = false;
			style.italic = false;
			style.underline = false;
		} else if (code === 1) {
			style.bold = true;
		} else if (code === 2) {
			style.dim = true;
		} else if (code === 3) {
			style.italic = true;
		} else if (code === 4) {
			style.underline = true;
		} else if (code === 22) {
			// 重置粗体和淡化样式。
			style.bold = false;
			style.dim = false;
		} else if (code === 23) {
			style.italic = false;
		} else if (code === 24) {
			style.underline = false;
		} else if (code >= 30 && code <= 37) {
			// 标准前景色。
			style.fg = ANSI_COLORS[code - 30];
		} else if (code === 38) {
			// 扩展前景色。
			if (params[i + 1] === 5 && params.length > i + 2) {
				// 256 色：38;5;N。
				style.fg = color256ToHex(params[i + 2]);
				i += 2;
			} else if (params[i + 1] === 2 && params.length > i + 4) {
				// RGB：38;2;R;G;B。
				const r = params[i + 2];
				const g = params[i + 3];
				const b = params[i + 4];
				style.fg = `rgb(${r},${g},${b})`;
				i += 4;
			}
		} else if (code === 39) {
			// 默认前景色。
			style.fg = null;
		} else if (code >= 40 && code <= 47) {
			// 标准背景色。
			style.bg = ANSI_COLORS[code - 40];
		} else if (code === 48) {
			// 扩展背景色。
			if (params[i + 1] === 5 && params.length > i + 2) {
				// 256 色：48;5;N。
				style.bg = color256ToHex(params[i + 2]);
				i += 2;
			} else if (params[i + 1] === 2 && params.length > i + 4) {
				// RGB：48;2;R;G;B。
				const r = params[i + 2];
				const g = params[i + 3];
				const b = params[i + 4];
				style.bg = `rgb(${r},${g},${b})`;
				i += 4;
			}
		} else if (code === 49) {
			// 默认背景色。
			style.bg = null;
		} else if (code >= 90 && code <= 97) {
			// 亮前景色。
			style.fg = ANSI_COLORS[code - 90 + 8];
		} else if (code >= 100 && code <= 107) {
			// 亮背景色。
			style.bg = ANSI_COLORS[code - 100 + 8];
		}
		// 忽略无法识别的代码。

		i++;
	}
}

// 匹配 ANSI 转义序列：ESC[ 后接参数，并以 'm' 结尾。
const ANSI_REGEX = /\x1b\[([\d;]*)m/g;

/**
 * 将带 ANSI 转义码的文本转换为带内联样式的 HTML。
 */
export function ansiToHtml(text: string): string {
	const style = createEmptyStyle();
	let result = "";
	let lastIndex = 0;
	let inSpan = false;

	// 重置正则表达式状态。
	ANSI_REGEX.lastIndex = 0;

	let match = ANSI_REGEX.exec(text);
	while (match !== null) {
		// 添加此转义序列之前的文本。
		const beforeText = text.slice(lastIndex, match.index);
		if (beforeText) {
			result += escapeHtml(beforeText);
		}

		// 解析 SGR 参数。
		const paramStr = match[1];
		const params = paramStr ? paramStr.split(";").map((p) => parseInt(p, 10) || 0) : [0];

		// 若已有 span，则将其关闭。
		if (inSpan) {
			result += "</span>";
			inSpan = false;
		}

		// 应用这些代码。
		applySgrCode(params, style);

		// 存在样式时，打开新的 span。
		if (hasStyle(style)) {
			result += `<span style="${styleToInlineCSS(style)}">`;
			inSpan = true;
		}

		lastIndex = match.index + match[0].length;
		match = ANSI_REGEX.exec(text);
	}

	// 添加剩余文本。
	const remainingText = text.slice(lastIndex);
	if (remainingText) {
		result += escapeHtml(remainingText);
	}

	// 关闭尚未结束的 span。
	if (inSpan) {
		result += "</span>";
	}

	return result;
}

/**
 * 将带 ANSI 转义码的行数组转换为 HTML。
 * 每行都用 div 元素包裹。
 */
export function ansiLinesToHtml(lines: string[]): string {
	return lines.map((line) => `<div class="ansi-line">${ansiToHtml(line) || "&nbsp;"}</div>`).join("");
}
