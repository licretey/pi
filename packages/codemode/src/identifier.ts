/**
 * 脚本用于调用工具的标识符：不符合 JavaScript 标识符规则的字符会替换为 `_`。
 * `mcp__docs__search` 保持不变，`my-tool` 会变为 `my_tool`。
 */
export function toCodemodeIdentifier(name: string): string {
	let identifier = "";
	for (const char of name) {
		const valid = identifier === "" ? /^[A-Za-z_$]$/.test(char) : /^[A-Za-z0-9_$]$/.test(char);
		identifier += valid ? char : "_";
	}
	return identifier === "" ? "_" : identifier;
}
