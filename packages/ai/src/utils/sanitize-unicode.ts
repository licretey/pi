/**
 * 从字符串中移除未配对的 Unicode 代理字符。
 *
 * 未配对的代理（高位代理 0xD800-0xDBFF 没有匹配的低位代理
 * 0xDC00-0xDFFF，或反之）会导致许多 API 提供商的 JSON 序列化出错。
 *
 * 有效的 emoji 及其他基本多文种平面（BMP）之外的字符使用正确配对的
 * 代理，不受本函数影响。
 *
 * @param text - 要清洗的文本
 * @returns 移除未配对代理后的干净文本
 *
 * @example
 * // 有效的表情符号（代理项正确配对）会被保留
 * sanitizeSurrogates("Hello 🙈 World") // => "Hello 🙈 World"
 *
 * // 未配对的高位代理项会被移除
 * const unpaired = String.fromCharCode(0xD83D); // high surrogate without low
 * sanitizeSurrogates(`Text ${unpaired} here`) // => "Text  here"
 */
export function sanitizeSurrogates(text: string): string {
	// 替换未配对的高位代理（0xD800-0xDBFF 后面没有低位代理）
	// 替换未配对的低位代理（0xDC00-0xDFFF 前面没有高位代理）
	return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}
