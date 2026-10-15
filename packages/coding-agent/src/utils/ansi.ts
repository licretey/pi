/*
 * Portions of this file are derived from:
 * - ansi-regex (https://github.com/chalk/ansi-regex)
 * - strip-ansi (https://github.com/chalk/strip-ansi)
 *
 * MIT License
 *
 * Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com)
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

// 有效的字符串终止符序列包括 BEL、ESC\ 和 0x9c。
const ST = "(?:\\u0007|\\u001B\\u005C|\\u009C)";

// OSC 序列：ESC ] ... ST。
const OSC_START = "\\u001B\\]";

// CSI 及相关序列：ESC/C1、可选中间字节、可选参数（支持 ; 和 :），最后是终止字节。
const CSI_START = "[\\u001B\\u009B][[\\]()#;?]*(?:\\d{1,4}(?:[;:]\\d{0,4})*)?";
const CSI_FINAL = "[\\dA-PR-TZcf-nq-uy=><~]";

// 完整序列。OSC 使用非贪婪匹配，直到遇到第一个 ST。
const ansiRegex = new RegExp(`(?:${OSC_START}[\\s\\S]*?${ST})|${CSI_START}${CSI_FINAL}`, "g");

// 文本末尾未完成的序列：缺少 ST 的 OSC（末尾 ESC 可能是 ESC\ 的开头），
// 或缺少终止字节的 CSI。
const unfinishedAnsiAtEndRegex = new RegExp(
	`(?:${OSC_START}(?:[^\\u0007\\u009C\\u001B]|\\u001B(?!\\\\))*|${CSI_START})$`,
);

// 流式处理中暂存的未完成序列的最大长度。超过此长度的序列按原样处理。
const MAX_PENDING_ANSI_LENGTH = 256;

/**
 * 将流式文本拆分为可立即传给 stripAnsi 的部分，以及应前置到下一块文本的末尾未完成转义序列。
 */
export function splitIncompleteAnsiSuffix(value: string): { complete: string; pending: string } {
	if (!value.includes("\u001B") && !value.includes("\u009B")) {
		return { complete: value, pending: "" };
	}
	const windowStart = Math.max(0, value.length - MAX_PENDING_ANSI_LENGTH);
	const match = unfinishedAnsiAtEndRegex.exec(value.slice(windowStart));
	if (!match) {
		return { complete: value, pending: "" };
	}
	const splitAt = windowStart + match.index;
	return { complete: value.slice(0, splitAt), pending: value.slice(splitAt) };
}

export function stripAnsi(value: string): string {
	if (typeof value !== "string") {
		throw new TypeError(`Expected a \`string\`, got \`${typeof value}\``);
	}

	// 快速路径：ANSI 控制码必须以 ESC（7 位）或 CSI（8 位）引导符开头。
	if (!value.includes("\u001B") && !value.includes("\u009B")) {
		return value;
	}

	// 尽管正则表达式带有全局标志，也无需重置 `.lastIndex`：与 `.exec()` 和 `.test()` 不同，
	// `.replace()` 会自动重置它；手动重置还会带来性能开销。
	return value.replace(ansiRegex, "");
}
