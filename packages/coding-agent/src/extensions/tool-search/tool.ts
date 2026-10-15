/**
 * 工具发现：基于工具元数据使用 BM25 排序器，由 codemode 脚本中的 `searchTools()` 和
 * 可选的 `tool_search` 工具共用。
 *
 * `tool_search` 会搜索尚未向模型声明的工具
 *（暴露方式为 `codemode` 和 `deferred`），并加载匹配项，使其在下一次模型调用时
 * 得到声明。加载过程会更新活动工具集，因此会像其他工具变更一样记录在对话记录中，
 * 并在该分支的 `/tree`、恢复和分叉操作后保留。
 */

import { type Static, Type } from "typebox";
import type {
	ExtensionAPI,
	ToolDefinition,
	ToolExposure,
	ToolInfo,
	ToolNamespace,
} from "../../core/extensions/types.ts";

export const TOOL_SEARCH_TOOL_NAME = "tool_search";
export const DEFAULT_TOOL_SEARCH_LIMIT = 8;

/** 排序器使用的工具信息：工具名称和由 {@link createToolSearchDocument} 构建的文本。 */
export interface ToolSearchDocument {
	name: string;
	text: string;
}

export interface ToolSearchMatch {
	name: string;
	score: number;
}

/** 根据查询为工具排序。当前使用 BM25；之后可替换为结合向量嵌入的混合排序器。 */
export interface ToolRanker {
	rank(query: string, documents: readonly ToolSearchDocument[], limit: number): ToolSearchMatch[];
}

const STOP_WORDS: ReadonlySet<string> = new Set([
	"a",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"by",
	"for",
	"from",
	"in",
	"is",
	"it",
	"of",
	"on",
	"or",
	"that",
	"the",
	"this",
	"to",
	"with",
]);

/** 简单的单数化处理，使 `issues` 能匹配 `issue`，`searches` 能匹配 `search`。 */
function stem(term: string): string {
	if (term.length > 4 && term.endsWith("ies")) return `${term.slice(0, -3)}y`;
	if (term.length > 4 && /(ches|shes|sses|xes|zes)$/.test(term)) return term.slice(0, -2);
	if (term.length > 3 && term.endsWith("s") && !term.endsWith("ss")) return term.slice(0, -1);
	return term;
}

/** 将词项转为小写，在驼峰边界和非字母数字字符处分割，并移除停用词。 */
export function tokenize(text: string): string[] {
	return text
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((term) => term.length > 0 && !STOP_WORDS.has(term))
		.map(stem);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 递归提取 Schema 说明和属性名称。 */
function schemaText(schema: unknown, parts: string[]): void {
	if (!isObject(schema)) return;
	if (typeof schema.description === "string") parts.push(schema.description);
	if (isObject(schema.properties)) {
		for (const [name, property] of Object.entries(schema.properties)) {
			parts.push(name);
			schemaText(property, parts);
		}
	}
	schemaText(schema.items, parts);
	for (const key of ["anyOf", "oneOf", "allOf"]) {
		const variants = schema[key];
		if (Array.isArray(variants)) for (const variant of variants) schemaText(variant, parts);
	}
}

/**
 * 工具的可搜索文本包括名称、将名称中的 `_`
 * 替换为空格后的名称、说明、Schema 说明和属性名称，以及命名空间的
 * 名称、说明和使用指引。
 */
export function createToolSearchDocument(
	tool: Pick<ToolInfo, "name" | "description" | "parameters">,
	namespace?: ToolNamespace,
): ToolSearchDocument {
	const parts = [tool.name, tool.name.replaceAll("_", " "), tool.description];
	schemaText(tool.parameters, parts);
	if (namespace) parts.push(namespace.name, namespace.description ?? "", namespace.instructions ?? "");
	return { name: tool.name, text: parts.filter((part) => part.trim()).join(" ") };
}

/** 使用常见参数的 Okapi BM25 排序。分数相同时保留文档原有顺序。 */
export class Bm25Ranker implements ToolRanker {
	private readonly k1: number;
	private readonly b: number;

	constructor(options: { k1?: number; b?: number } = {}) {
		this.k1 = options.k1 ?? 1.2;
		this.b = options.b ?? 0.75;
	}

	rank(query: string, documents: readonly ToolSearchDocument[], limit: number): ToolSearchMatch[] {
		const queryTerms = [...new Set(tokenize(query))];
		if (queryTerms.length === 0 || documents.length === 0 || limit <= 0) return [];
		const termCounts = documents.map((document) => {
			const counts = new Map<string, number>();
			for (const term of tokenize(document.text)) counts.set(term, (counts.get(term) ?? 0) + 1);
			return counts;
		});
		const lengths = termCounts.map((counts) => [...counts.values()].reduce((sum, count) => sum + count, 0));
		const averageLength = lengths.reduce((sum, length) => sum + length, 0) / documents.length || 1;
		const idf = new Map(
			queryTerms.map((term) => {
				const frequency = termCounts.filter((counts) => counts.has(term)).length;
				return [term, Math.log(1 + (documents.length - frequency + 0.5) / (frequency + 0.5))] as const;
			}),
		);
		const matches: ToolSearchMatch[] = [];
		documents.forEach((document, index) => {
			let score = 0;
			for (const term of queryTerms) {
				const count = termCounts[index].get(term);
				if (!count) continue;
				const norm = this.k1 * (1 - this.b + (this.b * lengths[index]) / averageLength);
				score += (idf.get(term) ?? 0) * ((count * (this.k1 + 1)) / (count + norm));
			}
			if (score > 0) matches.push({ name: document.name, score });
		});
		return matches.sort((a, b) => b.score - a.score).slice(0, limit);
	}
}

export const toolSearchSchema = Type.Object({
	query: Type.String({ description: "Search query for deferred tools." }),
	limit: Type.Optional(
		Type.Number({ description: `Maximum number of tools to return. Defaults to ${DEFAULT_TOOL_SEARCH_LIMIT}.` }),
	),
});

export type ToolSearchInput = Static<typeof toolSearchSchema>;

/** 判断该工具是否为当前的 `tool_search`，而非其他扩展注册的同名工具。 */
export function isToolSearchTool(tool: Pick<ToolInfo, "name" | "parameters">): boolean {
	return tool.name === TOOL_SEARCH_TOOL_NAME && tool.parameters === toolSearchSchema;
}

export interface ToolSearchResultTool {
	name: string;
	description: string;
}

export interface ToolSearchToolDetails {
	/** 本次调用加载的工具。 */
	loaded: string[];
}

export interface ToolSearchToolOptions {
	/**
	 * 会话中的工具。`tool_search` 会搜索尚未向模型声明的工具，
	 * 并激活匹配项。未提供此对象时将找不到工具。`ExtensionAPI` 符合此接口。
	 */
	tools?: Pick<ExtensionAPI, "getAllTools" | "getActiveTools" | "setActiveTools">;
}

/** 判断 `tool_search` 是否可以加载具有此暴露方式的工具。 */
function isSearchable(exposure: ToolExposure): boolean {
	return exposure === "codemode" || exposure === "deferred";
}

/**
 * 为尚未激活的可搜索工具排序并激活匹配项，使下一次模型
 * 调用能看到这些工具。激活操作会像其他工具变更一样记录在对话记录中。
 */
function searchAndLoad(
	tools: NonNullable<ToolSearchToolOptions["tools"]>,
	query: string,
	limit: number,
): ToolSearchResultTool[] {
	const active = tools.getActiveTools();
	const candidates = tools.getAllTools().filter((tool) => isSearchable(tool.exposure) && !active.includes(tool.name));
	const documents = candidates.map((tool) => createToolSearchDocument(tool, tool.namespace));
	const matches = new Bm25Ranker().rank(query, documents, limit);
	if (matches.length > 0) tools.setActiveTools([...active, ...matches.map((match) => match.name)]);
	return matches.map((match) => ({
		name: match.name,
		description: candidates.find((tool) => tool.name === match.name)?.description ?? "",
	}));
}

/**
 * `tool_search` 的说明。它不列出可搜索工具及其命名空间，因此工具注册状态变化时
 *（例如 MCP 服务器连接时）说明内容仍保持不变。
 */
export const TOOL_SEARCH_DESCRIPTION = `# Tool discovery\n\nSearches over deferred tool metadata with BM25 and exposes matching tools for the next model call.\n\nSome of the tools, such as tools of MCP servers, may not have been provided to you upfront, and you should use this tool (\`${TOOL_SEARCH_TOOL_NAME}\`) to search for the required tools. For MCP tool discovery, always use \`${TOOL_SEARCH_TOOL_NAME}\`.`;

export function createToolSearchToolDefinition(
	options: ToolSearchToolOptions = {},
): ToolDefinition<typeof toolSearchSchema, ToolSearchToolDetails> {
	return {
		name: TOOL_SEARCH_TOOL_NAME,
		label: TOOL_SEARCH_TOOL_NAME,
		description: TOOL_SEARCH_DESCRIPTION,
		promptSnippet: "Search for tools that are not loaded yet and load the matches",
		parameters: toolSearchSchema,
		// 搜索会改变模型可见的内容，因此不向脚本提供此功能。
		exposure: "model-only",
		async execute(_toolCallId, { query, limit }) {
			if (query.trim() === "") throw new Error("query must not be empty");
			const max = limit ?? DEFAULT_TOOL_SEARCH_LIMIT;
			if (!Number.isInteger(max) || max <= 0) throw new Error("limit must be a positive integer");
			const tools = options.tools ? searchAndLoad(options.tools, query, max) : [];
			const text =
				tools.length === 0
					? "No matching tools found."
					: `Loaded ${tools.length} tool${tools.length === 1 ? "" : "s"}. They are available from your next call:\n${tools
							.map((tool) => `- ${tool.name}: ${tool.description.trim().split(/\r?\n/)[0]}`)
							.join("\n")}`;
			return { content: [{ type: "text", text }], details: { loaded: tools.map((tool) => tool.name) } };
		},
	};
}
