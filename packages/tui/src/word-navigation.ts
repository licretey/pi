import { getWordSegmenter, isWhitespaceChar, PUNCTUATION_REGEX } from "./utils.ts";

const wordSegmenter = getWordSegmenter();

/**
 * 单词导航函数的选项。
 * 省略时，使用默认的 Intl.Segmenter 单词分段器。
 */
export interface WordNavigationOptions {
	/** 自定义分段器，返回给定文本中的词语片段。 */
	segment?: (text: string) => Iterable<Intl.SegmentData>;
	/** 用于识别应作为整体处理的原子片段的判断函数（例如粘贴标记）。 */
	isAtomicSegment?: (segment: string) => boolean;
}

/**
 * 返回光标在 `text` 中从 `cursor` 向前移动一个词后的位置。
 * 跳过末尾空白，然后停在下一个词语或标点边界。
 *
 * 纯函数，不会修改任何状态。
 */
export function findWordBackward(text: string, cursor: number, options?: WordNavigationOptions): number {
	if (cursor <= 0) return 0;

	const textBeforeCursor = text.slice(0, cursor);
	const segmentFn = options?.segment;
	const isAtomic = options?.isAtomicSegment;
	const segments = segmentFn ? [...segmentFn(textBeforeCursor)] : [...wordSegmenter.segment(textBeforeCursor)];
	let newCursor = cursor;

	// 跳过末尾空白
	while (
		segments.length > 0 &&
		!isAtomic?.(segments[segments.length - 1]?.segment || "") &&
		isWhitespaceChar(segments[segments.length - 1]?.segment || "")
	) {
		newCursor -= segments.pop()?.segment.length || 0;
	}

	if (segments.length === 0) return newCursor;

	const last = segments[segments.length - 1]!;

	if (isAtomic?.(last.segment)) {
		// 跳过一个原子片段。
		newCursor -= last.segment.length;
	} else if (last.isWordLike) {
		// 在一个类词语片段内移动，同时保留 ASCII 标点边界。
		const segment = last.segment;
		const matches = [...segment.matchAll(new RegExp(PUNCTUATION_REGEX, "g"))];
		if (matches.length <= 0) {
			newCursor -= segment.length;
		} else {
			const lastMatch = matches[matches.length - 1]!;
			newCursor -= segment.length - (lastMatch.index + lastMatch[0].length);
		}
	} else {
		// 跳过连续的非词语、非空白字符（标点）。
		while (
			segments.length > 0 &&
			!isAtomic?.(segments[segments.length - 1]?.segment || "") &&
			!segments[segments.length - 1]?.isWordLike &&
			!isWhitespaceChar(segments[segments.length - 1]?.segment || "")
		) {
			newCursor -= segments.pop()?.segment.length || 0;
		}
	}

	return newCursor;
}

/**
 * 返回光标在 `text` 中从 `cursor` 向后移动一个词后的位置。
 * 跳过开头空白，然后停在下一个词语或标点边界。
 *
 * 纯函数，不会修改任何状态。
 */
export function findWordForward(text: string, cursor: number, options?: WordNavigationOptions): number {
	if (cursor >= text.length) return text.length;

	const textAfterCursor = text.slice(cursor);
	const segmentFn = options?.segment;
	const isAtomic = options?.isAtomicSegment;
	const segments = segmentFn ? segmentFn(textAfterCursor) : wordSegmenter.segment(textAfterCursor);
	const iterator = segments[Symbol.iterator]();
	let next = iterator.next();
	let newCursor = cursor;

	// 跳过开头空白
	while (!next.done && !isAtomic?.(next.value.segment) && isWhitespaceChar(next.value.segment)) {
		newCursor += next.value.segment.length;
		next = iterator.next();
	}

	if (next.done) return newCursor;

	if (isAtomic?.(next.value.segment)) {
		// 跳过一个原子片段。
		newCursor += next.value.segment.length;
	} else if (next.value.isWordLike) {
		// 在一个类词语片段内移动，同时保留 ASCII 标点边界。
		newCursor += PUNCTUATION_REGEX.exec(next.value.segment)?.index ?? next.value.segment.length;
	} else {
		// 跳过连续的非词语、非空白字符（标点）。
		while (
			!next.done &&
			!isAtomic?.(next.value.segment) &&
			!next.value.isWordLike &&
			!isWhitespaceChar(next.value.segment)
		) {
			newCursor += next.value.segment.length;
			next = iterator.next();
		}
	}

	return newCursor;
}
