/** 从已解码文本中分离开头的 UTF-8 字节顺序标记。 */
export function splitBom(content: string): { bom: string; text: string } {
	return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

/** 移除解码文本开头的 UTF-8 字节顺序标记。 */
export function stripBom(content: string): string {
	return splitBom(content).text;
}
