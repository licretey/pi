/**
 * 逐块（分片）接收输入时，解码结果仍与对整体输入执行 `new TextDecoder().decode(bytes)` 一致。Node 带有 BOM 处理的
 * 流式解码器可能丢弃紧跟在分块边界之后的 U+FEFF，而不仅是开头的字节序标记（BOM），所以这些解码器关闭 BOM 处理，
 * 并自行去掉开头的标记。
 */

/** 面向字节区间的流式解码器；从文件开头开始解码的调用方需自行跳过开头的字节序标记。 */
export function rangeDecoder(): InstanceType<typeof TextDecoder> {
	return new TextDecoder("utf-8", { ignoreBOM: true });
}

/** 解码整个输入时，是否会将前三个字节作为字节序标记（BOM）丢弃。 */
export function startsWithBom(firstBytes: Uint8Array): boolean {
	return firstBytes[0] === 0xef && firstBytes[1] === 0xbb && firstBytes[2] === 0xbf;
}

/** 逐块地解码流，结果与一次性解码全部内容完全一致。 */
export class StreamDecoder {
	readonly #decoder = rangeDecoder();
	#started = false;

	/** 返回 `bytes` 解出的文本，未完整的字符会被扣留到下一块；不传 `bytes` 则表示流已结束。 */
	decode(bytes?: Uint8Array): string {
		const text = bytes === undefined ? this.#decoder.decode() : this.#decoder.decode(bytes, { stream: true });
		if (this.#started || text === "") return text;
		this.#started = true;
		// U+FEFF 只会编码为 EF BB BF，因此出现在流开头的 U+FEFF 恰好就是一个字节序标记（BOM）。
		return text.startsWith("\ufeff") ? text.slice(1) : text;
	}
}
