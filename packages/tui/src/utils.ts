import { eastAsianWidth } from "get-east-asian-width";

// segmenter（共享实例）
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

/**
 * 获取共享的 grapheme segmenter 实例。
 */
export function getGraphemeSegmenter(): Intl.Segmenter {
	return graphemeSegmenter;
}

/**
 * 获取共享的 word segmenter 实例。
 */
export function getWordSegmenter(): Intl.Segmenter {
	return wordSegmenter;
}

/**
 * 检查一个 grapheme cluster（分词后）是否可能是一个 RGI emoji。
 * 这是一个快速启发式判断，避免执行开销大的 rgiEmojiRegex 测试。
 * 被测试的 Unicode 区块刻意取得较宽，以便覆盖未来的 Unicode 扩充。
 */
function couldBeEmoji(segment: string): boolean {
	const cp = segment.codePointAt(0)!;
	return (
		(cp >= 0x1f000 && cp <= 0x1fbff) || // Emoji \u4E0E\u8C61\u5F62\u7B26\u53F7
		(cp >= 0x2300 && cp <= 0x23ff) || // \u6742\u9879\u6280\u672F\u7B26\u53F7
		(cp >= 0x2600 && cp <= 0x27bf) || // \u6742\u9879\u7B26\u53F7\u3001\u88C5\u9970\u7B26\u53F7
		(cp >= 0x2b50 && cp <= 0x2b55) || // \u7279\u5B9A\u7684\u661F\u5F62/\u5706\u5F62\u7B26\u53F7
		segment.includes("\uFE0F") || // \u5305\u542B VS16\uFF08emoji \u5448\u73B0\u9009\u62E9\u7B26\uFF09
		segment.length > 2 // \u591A codepoint \u5E8F\u5217\uFF08ZWJ\u3001\u80A4\u8272\u4FEE\u9970\u7B26\u7B49\uFF09
	);
}

// 用于字符分类的正则（与 string-width 库相同）
const zeroWidthRegex = /^(?:\p{Default_Ignorable_Code_Point}|\p{Control}|\p{Mark}|\p{Surrogate})+$/v;
const leadingNonPrintingRegex = /^[\p{Default_Ignorable_Code_Point}\p{Control}\p{Format}\p{Mark}\p{Surrogate}]+/v;
const nonPrintingCharRegex = /^(?:\p{Default_Ignorable_Code_Point}|\p{Control}|\p{Format}|\p{Mark}|\p{Surrogate})$/v;
const markCharRegex = /^\p{Mark}$/v;
// 终端在附着到基础字符时会为其分配单元格的 Mark。
// 这包括 Unicode 的 spacing mark，以及旧式 wcwidth 表中
// 不会占格的例外（non-spacing exceptions）。
const terminalSpacingMarkRegex =
	/^(?:[\p{Spacing_Mark}--[\u1734\u302E\u302F]]|[\u065F\u0F7F\u102B\u102C\u1031\u1033-\u1035\u1038\u103A-\u103E])+$/v;
const rgiEmojiRegex = /^\p{RGI_Emoji}$/v;

// 非 ASCII 字符串的缓存
const WIDTH_CACHE_SIZE = 512;
const widthCache = new Map<string, number>();

export const cjkBreakRegex =
	/[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}\p{Script_Extensions=Bopomofo}]/u;

// CJK 字符仍属于单词与路径的一部分；只有标点才能把正文与补全内容分开。
export const cjkPunctuationRegex = new RegExp(
	`(?:(?=\\p{Punctuation})${cjkBreakRegex.source}|[，．：；！？（）［］｛｝“”‘’…—])`,
	"u",
);
export const autocompleteSeparatorRegex = new RegExp(`(?:\\s|${cjkPunctuationRegex.source})`, "u");
export const autocompleteBoundaryRegex = new RegExp(`(?:^|${autocompleteSeparatorRegex.source})`, "u");

function isPrintableAscii(str: string): boolean {
	for (let i = 0; i < str.length; i++) {
		const code = str.charCodeAt(i);
		if (code < 0x20 || code > 0x7e) {
			return false;
		}
	}
	return true;
}

function truncateFragmentToWidth(text: string, maxWidth: number): { text: string; width: number } {
	if (maxWidth <= 0 || text.length === 0) {
		return { text: "", width: 0 };
	}

	if (isPrintableAscii(text)) {
		const clipped = text.slice(0, maxWidth);
		return { text: clipped, width: clipped.length };
	}

	const hasAnsi = text.includes("\x1b");
	const hasTabs = text.includes("\t");
	if (!hasAnsi && !hasTabs) {
		let result = "";
		let width = 0;
		for (const { segment } of graphemeSegmenter.segment(text)) {
			const w = graphemeWidth(segment);
			if (width + w > maxWidth) {
				break;
			}
			result += segment;
			width += w;
		}
		return { text: result, width };
	}

	let result = "";
	let width = 0;
	let i = 0;
	let pendingAnsi = "";

	while (i < text.length) {
		const ansi = extractAnsiCode(text, i);
		if (ansi) {
			pendingAnsi += ansi.code;
			i += ansi.length;
			continue;
		}

		if (text[i] === "\t") {
			if (width + 3 > maxWidth) {
				break;
			}
			if (pendingAnsi) {
				result += pendingAnsi;
				pendingAnsi = "";
			}
			result += "\t";
			width += 3;
			i++;
			continue;
		}

		let end = i;
		while (end < text.length && text[end] !== "\t") {
			const nextAnsi = extractAnsiCode(text, end);
			if (nextAnsi) {
				break;
			}
			end++;
		}

		for (const { segment } of graphemeSegmenter.segment(text.slice(i, end))) {
			const w = graphemeWidth(segment);
			if (width + w > maxWidth) {
				return { text: result, width };
			}
			if (pendingAnsi) {
				result += pendingAnsi;
				pendingAnsi = "";
			}
			result += segment;
			width += w;
		}
		i = end;
	}

	return { text: result, width };
}

function finalizeTruncatedResult(
	prefix: string,
	prefixWidth: number,
	ellipsis: string,
	ellipsisWidth: number,
	maxWidth: number,
	pad: boolean,
): string {
	const reset = "\x1b[0m";
	const hyperlinkClose = getActiveOsc8Close(prefix);
	const visibleWidth = prefixWidth + ellipsisWidth;
	let result: string;

	if (ellipsis.length > 0) {
		result = `${prefix}${hyperlinkClose}${reset}${ellipsis}${reset}`;
	} else {
		result = `${prefix}${hyperlinkClose}${reset}`;
	}

	return pad ? result + " ".repeat(Math.max(0, maxWidth - visibleWidth)) : result;
}

/**
 * 计算单个 grapheme cluster 占用的终端宽度。
 * 基于 string-width 库的代码，但加入了"可能是 emoji"的预判，
 * 避免不必要地运行 RGI_Emoji 正则。
 */
function graphemeWidth(segment: string): number {
	if (segment.length === 1) {
		const code = segment.charCodeAt(0);
		if (code >= 0x20 && code <= 0x7e) return 1;
		if (code === 0x09) return 3;
	}

	// 有些 mark 在没有基础字符时也会占据单元格。
	if (terminalSpacingMarkRegex.test(segment)) {
		return [...segment].length;
	}

	// 零宽 cluster
	if (zeroWidthRegex.test(segment)) {
		return 0;
	}

	// 带预过滤的 emoji 检查
	if (couldBeEmoji(segment) && rgiEmojiRegex.test(segment)) {
		return 2;
	}

	// 获取基础可见 codepoint
	const base = segment.replace(leadingNonPrintingRegex, "");
	const cp = base.codePointAt(0);
	if (cp === undefined) {
		return 0;
	}

	// 区域指示符号（U+1F1E6..U+1F1FF）在流式传输中被孤立时，
	// 终端通常仍按全宽 emoji 渲染。此处保守取宽度 2，
	// 避免终端自动换行产生错位伪影。
	if (cp >= 0x1f1e6 && cp <= 0x1f1ff) {
		return 2;
	}

	let width = eastAsianWidth(cp);

	// Intl.Segmenter 可能把多个终端占位码点归入同一个
	// grapheme。这里逐一统计终端可能为其分配单元格的尾部可见 codepoint：
	// mark 后的印度系辅音、半角/全角形式，以及泰语/老挝语的 AM 元音。
	let followsMark = false;
	const chars = [...base];
	for (const char of chars.slice(1)) {
		if (terminalSpacingMarkRegex.test(char)) {
			width += 1;
			followsMark = false;
		} else if (markCharRegex.test(char)) {
			followsMark = true;
		} else if (!nonPrintingCharRegex.test(char)) {
			const c = char.codePointAt(0)!;
			if (followsMark || (c >= 0xff00 && c <= 0xffef)) {
				// 半角 + 全角形式
				width += eastAsianWidth(c);
			} else if (c === 0x0e33 || c === 0x0eb3) {
				width += 1;
			}
			followsMark = false;
		}
	}

	return width;
}

/**
 * 计算字符串在终端列数下的可见宽度。
 */
export function visibleWidth(str: string): number {
	if (str.length === 0) {
		return 0;
	}

	// 快速路径：可打印 ASCII、tab 和 ANSI 转义序列。带样式的行都走这条路径，
	// 这样主题变更后的重渲染就不必对每行都做 grapheme 分词。
	const asciiWidth = asciiVisibleWidth(str);
	if (asciiWidth !== -1) {
		return asciiWidth;
	}

	// 查缓存
	const cached = widthCache.get(str);
	if (cached !== undefined) {
		return cached;
	}

	// 归一化：tab 转为 3 个空格，剥离 ANSI 转义码
	let clean = str;
	if (str.includes("\t")) {
		clean = clean.replace(/\t/g, "   ");
	}
	let escapeIndex = clean.indexOf("\x1b");
	if (escapeIndex !== -1) {
		// 一趟扫描剥离受支持的 ANSI/OSC/APC 转义序列。
		// 涵盖 CSI 样式/光标码、OSC 超链接与 prompt 标记，
		// 以及 CURSOR_MARKER 之类的 APC 序列。
		let stripped = "";
		let copyFrom = 0;
		while (escapeIndex !== -1) {
			const length = ansiCodeLength(clean, escapeIndex);
			if (length > 0) {
				stripped += clean.slice(copyFrom, escapeIndex);
				escapeIndex += length;
				copyFrom = escapeIndex;
			} else {
				escapeIndex++;
			}
			escapeIndex = clean.indexOf("\x1b", escapeIndex);
		}
		clean = stripped + clean.slice(copyFrom);
	}

	// 计算宽度
	let width = 0;
	for (const { segment } of graphemeSegmenter.segment(clean)) {
		width += graphemeWidth(segment);
	}

	// 缓存结果
	if (widthCache.size >= WIDTH_CACHE_SIZE) {
		const firstKey = widthCache.keys().next().value;
		if (firstKey !== undefined) {
			widthCache.delete(firstKey);
		}
	}
	widthCache.set(str, width);

	return width;
}

/** 移除 ANSI、OSC 与 APC 控制序列，同时保留可见文本。 */
export function stripTerminalSequences(str: string): string {
	if (!str.includes("\x1b")) return str;
	let result = "";
	let i = 0;
	while (i < str.length) {
		const ansi = extractAnsiCode(str, i);
		if (ansi) {
			i += ansi.length;
			continue;
		}
		result += str[i];
		i++;
	}
	return result;
}

interface GraphemeCellRange {
	start: number;
	end: number;
}

/** 返回指定可见列上的 grapheme 所占的终端单元格范围。 */
export function getGraphemeCellRange(line: string, column: number): GraphemeCellRange | undefined {
	let currentCol = 0;
	let i = 0;
	while (i < line.length) {
		const ansi = extractAnsiCode(line, i);
		if (ansi) {
			i += ansi.length;
			continue;
		}
		let textEnd = i;
		while (textEnd < line.length && !extractAnsiCode(line, textEnd)) textEnd++;
		for (const { segment } of graphemeSegmenter.segment(line.slice(i, textEnd))) {
			const width = graphemeWidth(segment);
			if (width > 0 && column >= currentCol && column < currentCol + width) {
				return { start: currentCol, end: currentCol + width };
			}
			currentCol += width;
		}
		i = textEnd;
	}
	return undefined;
}

/** 返回覆盖某一可见终端列的 OSC 8 超链接。 */
export function getOsc8LinkAtColumn(line: string, column: number): string | undefined {
	let activeUrl: string | undefined;
	let currentCol = 0;
	let i = 0;
	while (i < line.length) {
		const ansi = extractAnsiCode(line, i);
		if (ansi) {
			const hyperlink = /^\x1b\]8;[^;]*;([^\x07\x1b]*)(?:\x07|\x1b\\)$/.exec(ansi.code);
			if (hyperlink) activeUrl = hyperlink[1] || undefined;
			i += ansi.length;
			continue;
		}
		let textEnd = i;
		while (textEnd < line.length && !extractAnsiCode(line, textEnd)) textEnd++;
		for (const { segment } of graphemeSegmenter.segment(line.slice(i, textEnd))) {
			const width = segment === "\t" ? 3 : graphemeWidth(segment);
			if (column >= currentCol && column < currentCol + width) return activeUrl;
			currentCol += width;
		}
		i = textEnd;
	}
	return undefined;
}

/**
 * 在不改变 editor 逻辑内容的前提下，为终端输出做归一化。
 * 有些终端在差量重绘时对预先合成的泰语/老挝语 AM 元音渲染不一致。
 * 其兼容性分解形式具有相同的格宽，却能避免终端渲染器中的过期单元格伪影。
 * 可见的 tab 会被展开为布局所用的固定宽度，使终端的 tab 停位无法把
 * 逻辑行折行；而终端字符串序列内部的 tab 保持不变。
 */
const THAI_LAO_AM_REGEX = /[\u0e33\u0eb3]/;
const THAI_LAO_AM_GLOBAL_REGEX = /[\u0e33\u0eb3]/g;

export function normalizeTerminalOutput(str: string): string {
	let normalized = str;
	if (THAI_LAO_AM_REGEX.test(normalized)) {
		normalized = normalized.replace(THAI_LAO_AM_GLOBAL_REGEX, (char) =>
			char === "\u0e33" ? "\u0e4d\u0e32" : "\u0ecd\u0eb2",
		);
	}
	if (!normalized.includes("\t")) return normalized;

	let result = "";
	let i = 0;
	while (i < normalized.length) {
		const ansi = extractAnsiCode(normalized, i);
		if (ansi) {
			result += ansi.code;
			i += ansi.length;
			continue;
		}
		result += normalized[i] === "\t" ? "   " : normalized[i];
		i++;
	}
	return result;
}

/**
 * 从字符串的指定位置提取 ANSI 转义序列。
 */
export function extractAnsiCode(str: string, pos: number): { code: string; length: number } | null {
	const length = ansiCodeLength(str, pos);
	return length > 0 ? { code: str.substring(pos, pos + length), length } : null;
}

/**
 * 仅由可打印 ASCII、tab 和 ANSI 转义序列组成的字符串的宽度；
 * 若包含其他内容则返回 -1。对这类字符串与 `visibleWidth` 结果一致且无需分配。
 */
function asciiVisibleWidth(str: string): number {
	let width = 0;
	let i = 0;
	while (i < str.length) {
		const code = str.charCodeAt(i);
		if (code >= 0x20 && code <= 0x7e) {
			width++;
			i++;
		} else if (code === 0x09) {
			width += 3;
			i++;
		} else if (code === 0x1b) {
			const length = ansiCodeLength(str, i);
			if (length === 0) return -1;
			i += length;
		} else {
			return -1;
		}
	}
	return width;
}

/** 以 `pos` 为起点的 ANSI/OSC/APC 转义序列长度；不存在则为 0。 */
function ansiCodeLength(str: string, pos: number): number {
	if (pos >= str.length || str.charCodeAt(pos) !== 0x1b) return 0;

	const next = str[pos + 1];

	// CSI 序列：ESC [ ... m/G/K/H/J
	if (next === "[") {
		for (let j = pos + 2; j < str.length; j++) {
			const c = str.charCodeAt(j);
			// m、G、K、H、J
			if (c === 0x6d || c === 0x47 || c === 0x4b || c === 0x48 || c === 0x4a) return j + 1 - pos;
		}
		return 0;
	}

	// OSC 序列：ESC ] ... BEL 或 ESC ] ... ST（ESC \）
	// 用于超链接（OSC 8）、窗口标题等。
	// APC 序列：ESC _ ... BEL 或 ESC _ ... ST（ESC \）
	// 用于光标标记和应用专属命令
	if (next === "]" || next === "_") {
		for (let j = pos + 2; j < str.length; j++) {
			const c = str.charCodeAt(j);
			if (c === 0x07) return j + 1 - pos;
			if (c === 0x1b && str[j + 1] === "\\") return j + 2 - pos;
		}
		return 0;
	}

	return 0;
}

type Osc8Terminator = "\x07" | "\x1b\\";

interface ActiveHyperlink {
	params: string;
	url: string;
	terminator: Osc8Terminator;
}

function parseOsc8Hyperlink(ansiCode: string): ActiveHyperlink | null | undefined {
	if (!ansiCode.startsWith("\x1b]8;")) {
		return undefined;
	}

	const terminator: Osc8Terminator = ansiCode.endsWith("\x07") ? "\x07" : "\x1b\\";
	const body = ansiCode.slice(4, terminator === "\x07" ? -1 : -2);
	const separatorIndex = body.indexOf(";");
	if (separatorIndex === -1) {
		return undefined;
	}

	const params = body.slice(0, separatorIndex);
	const url = body.slice(separatorIndex + 1);
	if (!url) {
		return null;
	}
	return { params, url, terminator };
}

function formatOsc8Hyperlink(hyperlink: ActiveHyperlink): string {
	return `\x1b]8;${hyperlink.params};${hyperlink.url}${hyperlink.terminator}`;
}

function formatOsc8Close(terminator: Osc8Terminator): string {
	return `\x1b]8;;${terminator}`;
}

function getActiveOsc8Close(prefix: string): string {
	if (!prefix.includes("\x1b]8;")) {
		return "";
	}

	let activeHyperlink: ActiveHyperlink | null = null;
	let i = 0;
	while (i < prefix.length) {
		const ansi = extractAnsiCode(prefix, i);
		if (ansi) {
			const hyperlink = parseOsc8Hyperlink(ansi.code);
			if (hyperlink !== undefined) {
				activeHyperlink = hyperlink;
			}
			i += ansi.length;
		} else {
			i++;
		}
	}
	return activeHyperlink ? formatOsc8Close(activeHyperlink.terminator) : "";
}

/**
 * 跟踪处于激活状态的 ANSI SGR 码，使样式能够跨越换行保持。
 */
class AnsiCodeTracker {
	// 分别跟踪各个属性，以便单独重置它们
	private bold = false;
	private dim = false;
	private italic = false;
	private underline = false;
	private blink = false;
	private inverse = false;
	private hidden = false;
	private strikethrough = false;
	private fgColor: string | null = null; // 保存完整代码，如 "31" 或 "38;5;240"
	private bgColor: string | null = null; // 保存完整代码，如 "41" 或 "48;5;240"
	private activeHyperlink: ActiveHyperlink | null = null;

	process(ansiCode: string): void {
		// OSC 8 超链接：\x1b]8;;<url>\x1b\\（打开）或 \x1b]8;;\x1b\\（关闭）。
		// 保留原始终止符，因为有些终端只让以 BEL 结尾的链接可点击。
		// OAuth 登录 URL 用的就是 BEL，因此折行后若用 ST 重新打开，
		// 在这些终端上只有第一个物理行可点击。
		const hyperlink = parseOsc8Hyperlink(ansiCode);
		if (hyperlink !== undefined) {
			this.activeHyperlink = hyperlink;
			return;
		}

		if (!ansiCode.endsWith("m")) {
			return;
		}

		// 提取 \x1b[ 与 m 之间的参数
		const match = ansiCode.match(/\x1b\[([\d;]*)m/);
		if (!match) return;

		const params = match[1];
		if (params === "" || params === "0") {
			// 完全重置
			this.reset();
			return;
		}

		// 解析参数（可以是分号分隔的多个）
		const parts = params.split(";");
		let i = 0;
		while (i < parts.length) {
			const code = Number.parseInt(parts[i], 10);

			// 处理会占用多个参数的 256 色与 RGB 颜色码
			if (code === 38 || code === 48) {
				// 38;5;N（256 色 foreground）或 38;2;R;G;B（RGB foreground）
				// 48;5;N（256 色 background）或 48;2;R;G;B（RGB background）
				if (parts[i + 1] === "5" && parts[i + 2] !== undefined) {
					// 256 色：38;5;N 或 48;5;N
					const colorCode = `${parts[i]};${parts[i + 1]};${parts[i + 2]}`;
					if (code === 38) {
						this.fgColor = colorCode;
					} else {
						this.bgColor = colorCode;
					}
					i += 3;
					continue;
				} else if (parts[i + 1] === "2" && parts[i + 4] !== undefined) {
					// RGB 颜色：38;2;R;G;B 或 48;2;R;G;B
					const colorCode = `${parts[i]};${parts[i + 1]};${parts[i + 2]};${parts[i + 3]};${parts[i + 4]}`;
					if (code === 38) {
						this.fgColor = colorCode;
					} else {
						this.bgColor = colorCode;
					}
					i += 5;
					continue;
				}
			}

			// 标准 SGR 码
			switch (code) {
				case 0:
					this.reset();
					break;
				case 1:
					this.bold = true;
					break;
				case 2:
					this.dim = true;
					break;
				case 3:
					this.italic = true;
					break;
				case 4:
					this.underline = true;
					break;
				case 5:
					this.blink = true;
					break;
				case 7:
					this.inverse = true;
					break;
				case 8:
					this.hidden = true;
					break;
				case 9:
					this.strikethrough = true;
					break;
				case 21:
					this.bold = false;
					break; // 某些终端
				case 22:
					this.bold = false;
					this.dim = false;
					break;
				case 23:
					this.italic = false;
					break;
				case 24:
					this.underline = false;
					break;
				case 25:
					this.blink = false;
					break;
				case 27:
					this.inverse = false;
					break;
				case 28:
					this.hidden = false;
					break;
				case 29:
					this.strikethrough = false;
					break;
				case 39:
					this.fgColor = null;
					break; // 默认 foreground
				case 49:
					this.bgColor = null;
					break; // 默认 background
				default:
					// 标准 foreground 颜色 30-37、90-97
					if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
						this.fgColor = String(code);
					}
					// 标准 background 颜色 40-47、100-107
					else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
						this.bgColor = String(code);
					}
					break;
			}
			i++;
		}
	}

	private reset(): void {
		this.bold = false;
		this.dim = false;
		this.italic = false;
		this.underline = false;
		this.blink = false;
		this.inverse = false;
		this.hidden = false;
		this.strikethrough = false;
		this.fgColor = null;
		this.bgColor = null;
		// SGR 重置不影响 OSC 8 超链接状态
	}

	/** 清除所有状态以备复用。 */
	clear(): void {
		this.reset();
		this.activeHyperlink = null;
	}

	getActiveCodes(): string {
		const codes: string[] = [];
		if (this.bold) codes.push("1");
		if (this.dim) codes.push("2");
		if (this.italic) codes.push("3");
		if (this.underline) codes.push("4");
		if (this.blink) codes.push("5");
		if (this.inverse) codes.push("7");
		if (this.hidden) codes.push("8");
		if (this.strikethrough) codes.push("9");
		if (this.fgColor) codes.push(this.fgColor);
		if (this.bgColor) codes.push(this.bgColor);

		let result = codes.length > 0 ? `\x1b[${codes.join(";")}m` : "";
		if (this.activeHyperlink) {
			result += formatOsc8Hyperlink(this.activeHyperlink);
		}
		return result;
	}

	getActiveBackgroundCode(): string {
		return this.bgColor ? `\x1b[${this.bgColor}m` : "";
	}

	hasActiveCodes(): boolean {
		return (
			this.bold ||
			this.dim ||
			this.italic ||
			this.underline ||
			this.blink ||
			this.inverse ||
			this.hidden ||
			this.strikethrough ||
			this.fgColor !== null ||
			this.bgColor !== null ||
			this.activeHyperlink !== null
		);
	}

	/**
	 * 获取需要在一行结束时关闭的属性的重置码。
	 * 下划线必须关闭，以免渗入 padding 区域。
	 * 处于激活状态的 OSC 8 超链接必须关闭，并在下一行重新打开。
	 * 若没有需要关闭的属性，返回空字符串。
	 */
	getLineEndReset(): string {
		let result = "";
		if (this.underline) {
			result += "\x1b[24m"; // 仅关闭下划线
		}
		if (this.activeHyperlink) {
			result += formatOsc8Close(this.activeHyperlink.terminator); // 在行首通过 getActiveCodes() 重新打开
		}
		return result;
	}
}

function updateTrackerFromText(text: string, tracker: AnsiCodeTracker): void {
	let i = text.indexOf("\x1b");
	while (i !== -1) {
		const length = ansiCodeLength(text, i);
		if (length > 0) {
			tracker.process(text.substring(i, i + length));
			i += length;
		} else {
			i++;
		}
		i = text.indexOf("\x1b", i);
	}
}

/** 只返回 ANSI 样式字符串末尾处于激活状态的 background 颜色。 */
export function getActiveBackgroundAnsi(text: string): string {
	const tracker = new AnsiCodeTracker();
	updateTrackerFromText(text, tracker);
	return tracker.getActiveBackgroundCode();
}

function* graphemeSegments(text: string): Generator<string> {
	for (const { segment } of graphemeSegmenter.segment(text)) yield segment;
}

/**
 * 把文本拆分为单词，同时让 ANSI 码保持附着。
 */
function splitIntoTokensWithAnsi(text: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let pendingAnsi = ""; // 等待附着到下一个可见内容的 ANSI 码
	let currentKind: "space" | "word" | null = null;
	let i = 0;

	const flushCurrent = (): void => {
		if (!current) {
			return;
		}
		tokens.push(current);
		current = "";
		currentKind = null;
	};

	while (i < text.length) {
		const ansiResult = extractAnsiCode(text, i);
		if (ansiResult) {
			// 单独暂存 ANSI 码——它们将被附着到下一个可见字符
			pendingAnsi += ansiResult.code;
			i += ansiResult.length;
			continue;
		}

		// 可见文本一直延伸到下一个转义序列之前。
		let end = text.indexOf("\x1b", i + 1);
		while (end !== -1 && ansiCodeLength(text, end) === 0) {
			end = text.indexOf("\x1b", end + 1);
		}
		if (end === -1) end = text.length;

		const chunk = text.slice(i, end);
		// 可打印 ASCII 字符必然是单个 grapheme，因此对它们跳过分词器。
		const ascii = isPrintableAscii(chunk);
		for (const segment of ascii ? chunk : graphemeSegments(chunk)) {
			const segmentIsSpace = segment === " ";
			if (!ascii && !segmentIsSpace && cjkBreakRegex.test(segment)) {
				flushCurrent();
				const token = pendingAnsi + segment;
				pendingAnsi = "";
				tokens.push(token);
				continue;
			}

			const segmentKind = segmentIsSpace ? "space" : "word";
			if (current && currentKind !== segmentKind) {
				flushCurrent();
			}

			// 把暂存的 ANSI 码附着到该可见字符
			if (pendingAnsi) {
				current += pendingAnsi;
				pendingAnsi = "";
			}

			currentKind = segmentKind;
			current += segment;
		}

		i = end;
	}

	// 处理所有剩余的暂存 ANSI 码（附着到最后一个 token）
	if (pendingAnsi) {
		if (current) {
			current += pendingAnsi;
		} else if (tokens.length > 0) {
			tokens[tokens.length - 1] += pendingAnsi;
		} else {
			current = pendingAnsi;
		}
	}

	if (current) {
		tokens.push(current);
	}

	return tokens;
}

/**
 * 在保留 ANSI 码的前提下对文本做换行。
 *
 * 只做 word wrap——不做 padding，不做背景色。
 * 返回的每一行可见字符数都 <= width。
 * 激活中的 ANSI 码会跨越换行保持有效。
 *
 * @param text - 待换行的文本（可含 ANSI 码与换行符）
 * @param width - 每行最大可见宽度
 * @returns 换行后的行数组（不 padding 到 width）
 */
/**
 * 展平缓存的行。V8 会把拼接构建出来的字符串保留为一棵由各部分组成的树，
 * 直到有代码整体读取它为止；以这种树的形式持有的缓存行会占用数倍于自身
 * 的内存。把字符串转换成数字会触发整体读取，V8 因此原地将其展平；
 * 字符串的值不变。
 */
export function flattenLines(lines: readonly string[]): void {
	for (const line of lines) Number(line);
}

export function wrapTextWithAnsi(text: string, width: number): string[] {
	if (!text) {
		return [""];
	}

	// 通过逐行处理来应对换行符
	// 跨行跟踪 ANSI 状态，让样式在字面换行符之后继续生效
	const inputLines = text.split(/\r\n|\r|\n/);
	const result: string[] = [];
	const tracker = new AnsiCodeTracker();

	for (const inputLine of inputLines) {
		// 把前几行遗留的激活 ANSI 码前置（第一行除外）
		const prefix = result.length > 0 ? tracker.getActiveCodes() : "";
		const wrappedLines = wrapSingleLine(prefix + inputLine, width);
		for (const wrappedLine of wrappedLines) {
			result.push(wrappedLine);
		}
		// 用本行的码更新 tracker，供下一轮迭代使用
		updateTrackerFromText(inputLine, tracker);
	}

	return result.length > 0 ? result : [""];
}

function wrapSingleLine(line: string, width: number): string[] {
	if (!line) {
		return [""];
	}

	const visibleLength = visibleWidth(line);
	if (visibleLength <= width) {
		return [line];
	}

	const wrapped: string[] = [];
	const tracker = new AnsiCodeTracker();
	const tokens = splitIntoTokensWithAnsi(line);

	let currentLine = "";
	let currentVisibleLength = 0;

	for (const token of tokens) {
		const tokenVisibleLength = visibleWidth(token);
		const isWhitespace = token.trim() === "";

		// token 本身超长——逐字符折断
		if (tokenVisibleLength > width && !isWhitespace) {
			if (currentLine) {
				// 仅添加针对下划线的重置（保留背景）
				const lineEndReset = tracker.getLineEndReset();
				if (lineEndReset) {
					currentLine += lineEndReset;
				}
				wrapped.push(currentLine);
				currentLine = "";
				currentVisibleLength = 0;
			}

			// 折断超长 token——breakLongWord 自行处理重置
			const broken = breakLongWord(token, width, tracker);
			for (let i = 0; i < broken.length - 1; i++) {
				wrapped.push(broken[i]!);
			}
			currentLine = broken[broken.length - 1];
			currentVisibleLength = visibleWidth(currentLine);
			continue;
		}

		// 检查加入该 token 是否会超出宽度
		const totalNeeded = currentVisibleLength + tokenVisibleLength;

		if (totalNeeded > width && currentVisibleLength > 0) {
			// 去掉行尾空白，然后添加下划线重置（不是完全重置，以保留背景）
			let lineToWrap = currentLine.trimEnd();
			const lineEndReset = tracker.getLineEndReset();
			if (lineEndReset) {
				lineToWrap += lineEndReset;
			}
			wrapped.push(lineToWrap);
			if (isWhitespace) {
				// 不要以空白开启新行
				currentLine = tracker.getActiveCodes();
				currentVisibleLength = 0;
			} else {
				currentLine = tracker.getActiveCodes() + token;
				currentVisibleLength = tokenVisibleLength;
			}
		} else {
			// 追加到当前行
			currentLine += token;
			currentVisibleLength += tokenVisibleLength;
		}

		updateTrackerFromText(token, tracker);
	}

	if (currentLine) {
		// 最后一行末尾不做重置——交给调用方处理
		wrapped.push(currentLine);
	}

	// 行尾空白可能导致行宽超出请求的宽度
	return wrapped.length > 0 ? wrapped.map((line) => line.trimEnd()) : [""];
}

export const PUNCTUATION_REGEX = /[(){}[\]<>.,;:'"!?+\-=*/\\|&%^$#@~`]/;

/**
 * 检查一个字符是否为空白字符。
 */
export function isWhitespaceChar(char: string): boolean {
	return /\s/.test(char);
}

/**
 * 检查一个字符是否为标点符号。
 */
export function isPunctuationChar(char: string): boolean {
	return PUNCTUATION_REGEX.test(char);
}

function breakLongWord(word: string, width: number, tracker: AnsiCodeTracker): string[] {
	const lines: string[] = [];
	let currentLine = tracker.getActiveCodes();
	let currentWidth = 0;

	// 先把 ANSI 码与可见内容分离
	// ANSI 码不是 grapheme，需要特殊处理
	let i = 0;
	const segments: Array<{ type: "ansi" | "grapheme"; value: string }> = [];

	while (i < word.length) {
		const ansiResult = extractAnsiCode(word, i);
		if (ansiResult) {
			segments.push({ type: "ansi", value: ansiResult.code });
			i += ansiResult.length;
		} else {
			// 找到下一个 ANSI 码或字符串结尾
			let end = i;
			while (end < word.length) {
				const nextAnsi = extractAnsiCode(word, end);
				if (nextAnsi) break;
				end++;
			}
			// 把非 ANSI 部分切分为 grapheme
			const textPortion = word.slice(i, end);
			for (const seg of graphemeSegmenter.segment(textPortion)) {
				segments.push({ type: "grapheme", value: seg.segment });
			}
			i = end;
		}
	}

	// 现在处理各个段
	for (const seg of segments) {
		if (seg.type === "ansi") {
			currentLine += seg.value;
			tracker.process(seg.value);
			continue;
		}

		const grapheme = seg.value;
		// 跳过空 grapheme，避免 string-width 计算出问题
		if (!grapheme) continue;

		const graphemeWidth = visibleWidth(grapheme);

		if (currentWidth + graphemeWidth > width) {
			// 仅添加针对下划线的重置（保留背景）
			const lineEndReset = tracker.getLineEndReset();
			if (lineEndReset) {
				currentLine += lineEndReset;
			}
			lines.push(currentLine);
			currentLine = tracker.getActiveCodes();
			currentWidth = 0;
		}

		currentLine += grapheme;
		currentWidth += graphemeWidth;
	}

	if (currentLine) {
		// 最后一段末尾不做重置——由调用方处理续行
		lines.push(currentLine);
	}

	return lines.length > 0 ? lines : [""];
}

/**
 * 为一行应用背景色，并 padding 到完整宽度。
 *
 * @param line - 文本行（可含 ANSI 码）
 * @param width - 需要补齐到的总宽度
 * @param bgFn - 背景色函数
 * @returns 应用背景并 padding 到指定宽度后的行
 */
export function applyBackgroundToLine(line: string, width: number, bgFn: (text: string) => string): string {
	// 计算需要的 padding
	const visibleLen = visibleWidth(line);
	const paddingNeeded = Math.max(0, width - visibleLen);
	const padding = " ".repeat(paddingNeeded);

	// 对内容 + padding 应用背景
	const withPadding = line + padding;
	return bgFn(withPadding);
}

/**
 * 将文本截断到最大可见宽度以内，必要时添加省略号。
 * 可选择用空格 padding 到恰好 maxWidth。
 * 正确处理 ANSI 转义码（不计入宽度）。
 *
 * @param text - 待截断的文本（可含 ANSI 码）
 * @param maxWidth - 最大可见宽度
 * @param ellipsis - 截断时追加的省略号字符串（默认 "..."）
 * @param pad - 为 true 时用空格 padding 结果到恰好 maxWidth（默认 false）
 * @returns 截断后的文本，可选 padding 到恰好 maxWidth
 */
export function truncateToWidth(
	text: string,
	maxWidth: number,
	ellipsis: string = "...",
	pad: boolean = false,
): string {
	if (maxWidth <= 0) {
		return "";
	}

	if (text.length === 0) {
		return pad ? " ".repeat(maxWidth) : "";
	}

	const ellipsisWidth = visibleWidth(ellipsis);
	if (ellipsisWidth >= maxWidth) {
		const textWidth = visibleWidth(text);
		if (textWidth <= maxWidth) {
			return pad ? text + " ".repeat(maxWidth - textWidth) : text;
		}

		const clippedEllipsis = truncateFragmentToWidth(ellipsis, maxWidth);
		if (clippedEllipsis.width === 0) {
			return pad ? " ".repeat(maxWidth) : "";
		}
		return finalizeTruncatedResult("", 0, clippedEllipsis.text, clippedEllipsis.width, maxWidth, pad);
	}

	if (isPrintableAscii(text)) {
		if (text.length <= maxWidth) {
			return pad ? text + " ".repeat(maxWidth - text.length) : text;
		}
		const targetWidth = maxWidth - ellipsisWidth;
		return finalizeTruncatedResult(text.slice(0, targetWidth), targetWidth, ellipsis, ellipsisWidth, maxWidth, pad);
	}

	const targetWidth = maxWidth - ellipsisWidth;
	let result = "";
	let pendingAnsi = "";
	let visibleSoFar = 0;
	let keptWidth = 0;
	let keepContiguousPrefix = true;
	let overflowed = false;
	let exhaustedInput = false;
	const hasAnsi = text.includes("\x1b");
	const hasTabs = text.includes("\t");

	if (!hasAnsi && !hasTabs) {
		for (const { segment } of graphemeSegmenter.segment(text)) {
			const width = graphemeWidth(segment);
			if (keepContiguousPrefix && keptWidth + width <= targetWidth) {
				result += segment;
				keptWidth += width;
			} else {
				keepContiguousPrefix = false;
			}
			visibleSoFar += width;
			if (visibleSoFar > maxWidth) {
				overflowed = true;
				break;
			}
		}
		exhaustedInput = !overflowed;
	} else {
		let i = 0;
		while (i < text.length) {
			const ansi = extractAnsiCode(text, i);
			if (ansi) {
				pendingAnsi += ansi.code;
				i += ansi.length;
				continue;
			}

			if (text[i] === "\t") {
				if (keepContiguousPrefix && keptWidth + 3 <= targetWidth) {
					if (pendingAnsi) {
						result += pendingAnsi;
						pendingAnsi = "";
					}
					result += "\t";
					keptWidth += 3;
				} else {
					keepContiguousPrefix = false;
					pendingAnsi = "";
				}
				visibleSoFar += 3;
				if (visibleSoFar > maxWidth) {
					overflowed = true;
					break;
				}
				i++;
				continue;
			}

			let end = i;
			while (end < text.length && text[end] !== "\t") {
				const nextAnsi = extractAnsiCode(text, end);
				if (nextAnsi) {
					break;
				}
				end++;
			}

			for (const { segment } of graphemeSegmenter.segment(text.slice(i, end))) {
				const width = graphemeWidth(segment);
				if (keepContiguousPrefix && keptWidth + width <= targetWidth) {
					if (pendingAnsi) {
						result += pendingAnsi;
						pendingAnsi = "";
					}
					result += segment;
					keptWidth += width;
				} else {
					keepContiguousPrefix = false;
					pendingAnsi = "";
				}

				visibleSoFar += width;
				if (visibleSoFar > maxWidth) {
					overflowed = true;
					break;
				}
			}
			if (overflowed) {
				break;
			}
			i = end;
		}
		exhaustedInput = i >= text.length;
	}

	if (!overflowed && exhaustedInput) {
		return pad ? text + " ".repeat(Math.max(0, maxWidth - visibleSoFar)) : text;
	}

	return finalizeTruncatedResult(result, keptWidth, ellipsis, ellipsisWidth, maxWidth, pad);
}

/**
 * 从一行中提取指定范围的可见列。正确处理 ANSI 码与宽字符。
 * @param strict - 为 true 时，排除会超出范围边界的宽字符
 */
export function sliceByColumn(line: string, startCol: number, length: number, strict = false): string {
	return sliceWithWidth(line, startCol, length, strict).text;
}

/** 与 sliceByColumn 类似，但还会返回结果的实际可见宽度。 */
export function sliceWithWidth(
	line: string,
	startCol: number,
	length: number,
	strict = false,
): { text: string; width: number } {
	if (length <= 0) return { text: "", width: 0 };
	const endCol = startCol + length;
	let result = "",
		resultWidth = 0,
		currentCol = 0,
		i = 0,
		pendingAnsi = "";

	while (i < line.length) {
		const ansi = extractAnsiCode(line, i);
		if (ansi) {
			if (currentCol >= startCol && currentCol < endCol) {
				// 保持原始顺序：范围之前的码必须排在边界处码的前面
				result += pendingAnsi + ansi.code;
				pendingAnsi = "";
			} else if (currentCol < startCol) pendingAnsi += ansi.code;
			i += ansi.length;
			continue;
		}

		let textEnd = i;
		while (textEnd < line.length && !extractAnsiCode(line, textEnd)) textEnd++;

		for (const { segment } of graphemeSegmenter.segment(line.slice(i, textEnd))) {
			const w = graphemeWidth(segment);
			const inRange = currentCol >= startCol && currentCol < endCol;
			const fits = !strict || currentCol + w <= endCol;
			if (inRange && fits) {
				if (pendingAnsi) {
					result += pendingAnsi;
					pendingAnsi = "";
				}
				result += segment;
				resultWidth += w;
			}
			currentCol += w;
			if (currentCol >= endCol) break;
		}
		i = textEnd;
		if (currentCol >= endCol) break;
	}
	return { text: result, width: resultWidth };
}

// 供 extractSegments 使用的共享 tracker 实例（避免每次调用都分配）
const pooledStyleTracker = new AnsiCodeTracker();

/**
 * 一趟扫描中从一行内提取"overlay 之前"与"overlay 之后"两段内容。
 * 用于 overlay 合成场景：需要 overlay 区域前后各自的内容。
 * 保留 overlay 之前、但应影响其后内容的样式。
 */
export function extractSegments(
	line: string,
	beforeEnd: number,
	afterStart: number,
	afterLen: number,
	strictAfter = false,
): { before: string; beforeWidth: number; after: string; afterWidth: number } {
	let before = "",
		beforeWidth = 0,
		after = "",
		afterWidth = 0;
	let currentCol = 0,
		i = 0;
	let pendingAnsiBefore = "";
	let afterStarted = false;
	const afterEnd = afterStart + afterLen;

	// 跟踪样式状态，让"after"段继承 overlay 之前的样式
	pooledStyleTracker.clear();

	while (i < line.length) {
		const ansi = extractAnsiCode(line, i);
		if (ansi) {
			// 跟踪所有 SGR 码，以掌握 afterStart 处的样式状态
			pooledStyleTracker.process(ansi.code);
			// 将 ANSI 码归入各自所属的段
			if (currentCol < beforeEnd) {
				pendingAnsiBefore += ansi.code;
			} else if (
				currentCol >= afterStart &&
				currentCol < afterEnd &&
				(afterStarted || ansi.code.startsWith("\x1b_"))
			) {
				// SGR 码只在"after"段开始后才纳入（样式已前置）。零宽的 APC
				// 标记如 CURSOR_MARKER 不属于被跟踪的样式，因此也保留在边界处。
				after += ansi.code;
			}
			i += ansi.length;
			continue;
		}

		let textEnd = i;
		while (textEnd < line.length && !extractAnsiCode(line, textEnd)) textEnd++;

		for (const { segment } of graphemeSegmenter.segment(line.slice(i, textEnd))) {
			const w = graphemeWidth(segment);

			if (currentCol < beforeEnd && currentCol + w <= beforeEnd) {
				if (pendingAnsiBefore) {
					before += pendingAnsiBefore;
					pendingAnsiBefore = "";
				}
				before += segment;
				beforeWidth += w;
			} else if (currentCol >= afterStart && currentCol < afterEnd) {
				const fits = !strictAfter || currentCol + w <= afterEnd;
				if (fits) {
					// 在第一个"after"grapheme 上，前置从 overlay 之前继承的样式
					if (!afterStarted) {
						after += pooledStyleTracker.getActiveCodes();
						afterStarted = true;
					}
					after += segment;
					afterWidth += w;
				}
			}

			currentCol += w;
			// 提前退出：仅完成"before"段，或两段都已完成
			if (afterLen <= 0 ? currentCol >= beforeEnd : currentCol >= afterEnd) break;
		}
		i = textEnd;
		if (afterLen <= 0 ? currentCol >= beforeEnd : currentCol >= afterEnd) break;
	}

	return { before, beforeWidth, after, afterWidth };
}
