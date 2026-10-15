/**
 * 程序状态协议（OSC 7501）：程序向终端报告自身处于空闲、运行中、等待用户、已完成或失败状态。
 * 目前仅支持根记录。
 *
 * 规范：https://www.superlogical.com/rex/docs/build/program-status
 */

export interface ProgramStatus {
	/** `clear` 用于清除状态，而不是报告新状态。 */
	state: "idle" | "working" | "blocked" | "done" | "error" | "clear";
	/** 稳定的程序名称，格式为 `[A-Za-z0-9_.+-]{1,32}`。不符合格式的值会被省略。 */
	app?: string;
	/** 程序阻塞时正在等待的事项；其他状态下省略。 */
	kind?: "permission" | "question" | "auth";
	/** 一行可读文本。控制字符会替换为空格；超长文本会按规范限制截断。 */
	message?: string;
}

/** 功能探测查询。支持此功能的终端会返回相同的消息体。 */
export const PROGRAM_STATUS_QUERY = "\x1b]7501;?\x1b\\";

/** 对 {@link PROGRAM_STATUS_QUERY} 的响应。后续规范版本可能会在 `?` 后添加键值对。 */
export function isProgramStatusReply(sequence: string): boolean {
	return /^\x1b\]7501;\?[^\x07\x1b]*(?:\x07|\x1b\\)$/.test(sequence);
}

const APP_PATTERN = /^[A-Za-z0-9_.+-]{1,32}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]+/g;
/** 解码后 `msg` 的长度上限；其 Base64 编码长度不超过 2732 字节。 */
const MAX_MESSAGE_BYTES = 2048;

function truncateUtf8(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	let bytes = 0;
	let end = 0;
	for (const char of text) {
		const size = Buffer.byteLength(char, "utf8");
		if (bytes + size > maxBytes) break;
		bytes += size;
		end += char.length;
	}
	return text.slice(0, end);
}

/** 编码状态报告。终端会丢弃文本含控制字符的报告，因此此处会先替换这些字符。 */
export function formatProgramStatus(status: ProgramStatus): string {
	const pairs = [`state=${status.state}`];
	if (status.app !== undefined && APP_PATTERN.test(status.app)) pairs.push(`app=${status.app}`);
	if (status.state === "blocked" && status.kind) pairs.push(`kind=${status.kind}`);
	const message = truncateUtf8((status.message ?? "").replace(CONTROL_CHARACTERS, " ").trim(), MAX_MESSAGE_BYTES);
	if (message) pairs.push(`msg=${Buffer.from(message, "utf8").toString("base64")}`);
	return `\x1b]7501;${pairs.join(":")}\x1b\\`;
}
