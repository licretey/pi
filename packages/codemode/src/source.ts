/**
 * Codemode 源码格式：JavaScript，可选地在开头添加一行选项。
 *
 * ```js
 * // @options: {"max_output_tokens": 2000, "timeout_ms": 30000}
 * const text = await tools.read({ path: "package.json" });
 * text(JSON.parse(text).name);
 * ```
 */

export const CODEMODE_OPTIONS_PREFIX = "// @options:";

const SUPPORTED_FIELDS = ["max_output_tokens", "timeout_ms"] as const;
const SUPPORTED_FIELDS_TEXT = "`max_output_tokens` and `timeout_ms`";
/** `setTimeout` 支持的最大延迟，也是 `timeout_ms` 的上限。 */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * 供使用语法约束工具输入的提供商使用的 Lark 语法。它只约束选项行的格式；
 * 选项 JSON 和代码本身由 {@link parseCodemodeSource} 检查。
 */
export const CODEMODE_SOURCE_GRAMMAR = String.raw`
start: options_source | plain_source
options_source: OPTIONS_LINE NEWLINE SOURCE
plain_source: SOURCE

OPTIONS_LINE: /[ \t]*\/\/ @options:[^\r\n]*/
NEWLINE: /\r?\n/
SOURCE: /[\s\S]+/
`;

export interface CodemodeSourceOptions {
	/** 脚本输出的 token 数上限。 */
	maxOutputTokens?: number;
	/** 整个脚本的硬性截止时间，单位为毫秒，包含工具调用耗时。 */
	timeoutMs?: number;
}

export interface ParsedCodemodeSource {
	/** 将选项行替换为空行后的脚本，以保持行号不变。 */
	code: string;
	options: CodemodeSourceOptions;
}

export class CodemodeSourceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CodemodeSourceError";
	}
}

function isSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseOptions(directive: string): CodemodeSourceOptions {
	if (directive === "") {
		throw new CodemodeSourceError(`@options must be a JSON object with supported fields ${SUPPORTED_FIELDS_TEXT}`);
	}
	let value: unknown;
	try {
		value = JSON.parse(directive);
	} catch (error) {
		throw new CodemodeSourceError(
			`@options must be valid JSON with supported fields ${SUPPORTED_FIELDS_TEXT}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new CodemodeSourceError(`@options must be a JSON object with supported fields ${SUPPORTED_FIELDS_TEXT}`);
	}
	const fields = value as Record<string, unknown>;
	for (const key of Object.keys(fields)) {
		if (!(SUPPORTED_FIELDS as readonly string[]).includes(key)) {
			throw new CodemodeSourceError(`@options only supports ${SUPPORTED_FIELDS_TEXT}; got \`${key}\``);
		}
	}
	const options: CodemodeSourceOptions = {};
	const { max_output_tokens, timeout_ms } = fields;
	if (max_output_tokens !== undefined) {
		if (!isSafeInteger(max_output_tokens)) {
			throw new CodemodeSourceError("@options field `max_output_tokens` must be a non-negative safe integer");
		}
		options.maxOutputTokens = max_output_tokens;
	}
	if (timeout_ms !== undefined) {
		if (!isSafeInteger(timeout_ms) || timeout_ms === 0 || timeout_ms > MAX_TIMEOUT_MS) {
			throw new CodemodeSourceError(
				`@options field \`timeout_ms\` must be a positive integer up to ${MAX_TIMEOUT_MS}`,
			);
		}
		options.timeoutMs = timeout_ms;
	}
	return options;
}

/**
 * 从脚本中拆分可选的首行 `// @options: {...}`。输入为空或选项无效时，
 * 会抛出 {@link CodemodeSourceError}。
 */
export function parseCodemodeSource(input: string): ParsedCodemodeSource {
	if (input.trim() === "") {
		throw new CodemodeSourceError(
			'Expected JavaScript source text (non-empty). Provide JS only, optionally with a first line `// @options: {"max_output_tokens": 1000}`.',
		);
	}
	const newline = input.indexOf("\n");
	const firstLine = (newline === -1 ? input : input.slice(0, newline)).replace(/\r$/, "");
	const trimmed = firstLine.trimStart();
	if (!trimmed.startsWith(CODEMODE_OPTIONS_PREFIX)) return { code: input, options: {} };
	const code = newline === -1 ? "" : input.slice(newline);
	if (code.trim() === "") {
		throw new CodemodeSourceError("The @options line must be followed by JavaScript source on subsequent lines");
	}
	return { code, options: parseOptions(trimmed.slice(CODEMODE_OPTIONS_PREFIX.length).trim()) };
}
