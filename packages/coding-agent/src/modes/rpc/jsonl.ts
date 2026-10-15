import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

/**
 * 序列化一条严格格式的 JSONL 记录。
 *
 * 记录仅使用 LF 分隔。负载字符串可以包含 U+2028、U+2029 等其他 Unicode 分隔符。
 * 客户端必须仅按 `\n` 拆分记录。
 */
export function serializeJsonLine(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}

/**
 * 为流附加一个仅按 LF 分隔记录的 JSONL 读取器。
 *
 * 此处刻意不使用 Node readline。readline 还会按其他 Unicode 分隔符拆分，
 * 而这些分隔符在 JSON 字符串中是合法内容，因此无法实现严格的 JSONL 分帧。
 */
export function attachJsonlLineReader(stream: Readable, onLine: (line: string) => void): () => void {
	const decoder = new StringDecoder("utf8");
	let buffer = "";

	const emitLine = (line: string) => {
		onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
	};

	const onData = (chunk: string | Buffer) => {
		buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);

		while (true) {
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex === -1) {
				return;
			}

			emitLine(buffer.slice(0, newlineIndex));
			buffer = buffer.slice(newlineIndex + 1);
		}
	};

	const onEnd = () => {
		buffer += decoder.end();
		if (buffer.length > 0) {
			emitLine(buffer);
			buffer = "";
		}
	};

	stream.on("data", onData);
	stream.on("end", onEnd);

	return () => {
		stream.off("data", onData);
		stream.off("end", onEnd);
	};
}
