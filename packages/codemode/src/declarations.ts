import { toCodemodeIdentifier } from "./identifier.ts";

export { toCodemodeIdentifier };

import type { CodemodeJsonSchema, CodemodeTool } from "./types.ts";

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const INDENT = "  ";
/** 输入类型声明在退化为 `unknown` 前允许的最大字符数。 */
export const DEFAULT_INPUT_SCHEMA_MAX_CHARS = 16_000;
/** 每个生成的 schema 最多展开的本地 `$ref` 数量，避免共享定义导致输出过大。 */
const MAX_REF_EXPANSIONS = 32;

/**
 * 根据 MCP 的 `CallToolResult` schema 定义的 MCP 结果 TypeScript 类型，供 `CallToolResult<T>`
 * 声明引用。
 */
export const MCP_TYPESCRIPT_PREAMBLE = `type Role = "user" | "assistant";
type MetaObject = Record<string, unknown>;
type Annotations = {
  audience?: Role[];
  priority?: number;
  lastModified?: string;
};
type Icon = {
  src: string;
  mimeType?: string;
  sizes?: string[];
  theme?: "light" | "dark";
};
type TextResourceContents = {
  uri: string;
  mimeType?: string;
  _meta?: MetaObject;
  text: string;
};
type BlobResourceContents = {
  uri: string;
  mimeType?: string;
  _meta?: MetaObject;
  blob: string;
};
type TextContent = {
  type: "text";
  text: string;
  annotations?: Annotations;
  _meta?: MetaObject;
};
type ImageContent = {
  type: "image";
  data: string;
  mimeType: string;
  annotations?: Annotations;
  _meta?: MetaObject;
};
type AudioContent = {
  type: "audio";
  data: string;
  mimeType: string;
  annotations?: Annotations;
  _meta?: MetaObject;
};
type ResourceLink = {
  icons?: Icon[];
  name: string;
  title?: string;
  uri: string;
  description?: string;
  mimeType?: string;
  annotations?: Annotations;
  size?: number;
  _meta?: MetaObject;
  type: "resource_link";
};
type EmbeddedResource = {
  type: "resource";
  resource: TextResourceContents | BlobResourceContents;
  annotations?: Annotations;
  _meta?: MetaObject;
};
type ContentBlock =
  | TextContent
  | ImageContent
  | AudioContent
  | ResourceLink
  | EmbeddedResource;
type CallToolResult<TStructured = { [key: string]: unknown }> = {
  _meta?: MetaObject;
  content: ContentBlock[];
  isError?: boolean;
  structuredContent?: TStructured;
  [key: string]: unknown;
};`;

export interface RenderDeclarationsOptions {
	tools?: readonly CodemodeTool[];
	globals?: readonly CodemodeTool[];
}

/**
 * 为脚本可见的 API 生成 TypeScript 声明。工具会成为 `declare const tools` 的成员，
 * 全局函数会生成 `declare function` 语句，`ns.member` 形式的全局函数会成为 `declare const ns` 的成员。
 * 描述会转换为文档注释，schema 会转换为类型。
 */
export function renderDeclarations(options: RenderDeclarationsOptions): string {
	const sections: string[] = [];
	const tools = options.tools ?? [];
	if (tools.length > 0) {
		const members = tools.map(
			(tool) => `${docComment(tool.description, INDENT)}${INDENT}${renderToolSignature(tool)}`,
		);
		sections.push(`declare const tools: {\n${members.join("\n")}\n};`);
	}
	const namespaces = new Map<string, string[]>();
	for (const global of options.globals ?? []) {
		const dot = global.name.indexOf(".");
		if (dot === -1) {
			sections.push(renderGlobal(`declare function ${global.name}`, global, ""));
			continue;
		}
		const namespace = global.name.slice(0, dot);
		const members = namespaces.get(namespace) ?? [];
		if (members.length === 0) namespaces.set(namespace, members);
		members.push(renderGlobal(global.name.slice(dot + 1), global, INDENT));
	}
	for (const [namespace, members] of namespaces) {
		sections.push(`declare const ${namespace}: {\n${members.join("\n")}\n};`);
	}
	return sections.join("\n\n");
}

/**
 * 将单个工具生成为 `tools` 对象的成员，形式为 `name(args: T): Promise<R>;`，
 * 其中名称是脚本使用的标识符。输入类型超过 `inputMaxChars` 时会生成为 `unknown`。
 * 输出 schema 为 MCP `CallToolResult` 的工具会生成为 `Promise<CallToolResult<T>>`，
 * 这需要 {@link MCP_TYPESCRIPT_PREAMBLE}。
 */
export function renderToolSignature(
	tool: Pick<CodemodeTool, "name" | "inputSchema" | "outputSchema">,
	options: { inputMaxChars?: number } = {},
): string {
	const input =
		tool.inputSchema === undefined
			? "unknown"
			: schemaToType(tool.inputSchema, { maxChars: options.inputMaxChars ?? DEFAULT_INPUT_SCHEMA_MAX_CHARS });
	return `${toCodemodeIdentifier(tool.name)}(args: ${input}): Promise<${renderToolOutputType(tool.outputSchema)}>;`;
}

/**
 * 工具的示例文本：先列出描述，再列出工具声明。用于工具列表和 `ALL_TOOLS` 条目。
 */
export function renderToolSample(
	tool: Pick<CodemodeTool, "name" | "description" | "inputSchema" | "outputSchema">,
	options: { inputMaxChars?: number } = {},
): string {
	const declaration = `declare const tools: { ${renderToolSignature(tool, options)} };`;
	return `${tool.description?.trim() ?? ""}\n\ncodemode tool declaration:\n\`\`\`ts\n${declaration}\n\`\`\``;
}

/**
 * 获取 MCP `CallToolResult` 输出 schema 中的 `structuredContent` schema。通过对象数组形式的
 * `content`、布尔值 `isError` 和对象 `_meta` 进行识别；未声明时返回 `true`，
 * schema 不是 `CallToolResult` 时返回 `undefined`。
 */
export function mcpStructuredContentSchema(schema: CodemodeJsonSchema | undefined): CodemodeJsonSchema | undefined {
	if (!isObject(schema) || !isObject(schema.properties)) return undefined;
	const { content, isError, _meta, structuredContent } = schema.properties;
	if (!isObject(content) || content.type !== "array" || !isObject(content.items) || content.items.type !== "object") {
		return undefined;
	}
	if (!isObject(isError) || isError.type !== "boolean" || !isObject(_meta) || _meta.type !== "object")
		return undefined;
	return isObject(structuredContent) || typeof structuredContent === "boolean" ? structuredContent : true;
}

/**
 * 工具调用结果的类型：MCP 输出 schema 使用 `CallToolResult<T>`（需要 {@link MCP_TYPESCRIPT_PREAMBLE}），
 * 其他情况使用 schema 对应的类型；没有 schema 时使用 `unknown`。
 */
export function renderToolOutputType(schema: CodemodeJsonSchema | undefined): string {
	const structured = mcpStructuredContentSchema(schema);
	if (structured !== undefined) {
		const type = schemaToType(structured);
		return type === "unknown" ? "CallToolResult" : `CallToolResult<${type}>`;
	}
	return schema === undefined ? "unknown" : schemaToType(schema);
}

function renderGlobal(head: string, global: CodemodeTool, indent: string): string {
	if (global.signature !== undefined) {
		return `${docComment(global.description, indent)}${indent}${head}${global.signature};`;
	}
	const input = global.inputSchema === undefined ? "unknown" : schemaToType(global.inputSchema);
	const output = global.outputSchema === undefined ? "unknown" : schemaToType(global.outputSchema);
	return `${docComment(global.description, indent)}${indent}${head}(args: ${input}): Promise<${output}>;`;
}

function docComment(description: string | undefined, indent: string): string {
	const text = description?.trim();
	if (!text) return "";
	const lines = text.replaceAll("*/", "*\\/").split(/\r?\n/);
	if (lines.length === 1) return `${indent}/** ${lines[0]} */\n`;
	return `${indent}/**\n${lines.map((line) => `${indent} *${line ? ` ${line}` : ""}`).join("\n")}\n${indent} */\n`;
}

function propertyKey(name: string): string {
	return IDENTIFIER.test(name) ? name : JSON.stringify(name);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function union(types: string[]): string {
	const unique = [...new Set(types)];
	if (unique.includes("unknown")) return "unknown";
	return unique.length === 0 ? "never" : unique.join(" | ");
}

/**
 * 将 JSON Schema 转换为 TypeScript 类型表达式：对象属性按名称排序，默认单行输出
 *（`{ a: string; b?: number; }`）；属性带有描述时，会按每行一个属性并添加 `//` 注释的形式输出；
 * 数组使用 `Array<T>`。本地引用（`#/$defs/...`、`#/definitions/...`）会相对于 `schema` 解析；
 * 递归引用和远程引用会生成为 `unknown`。结果超过 `maxChars` 时也会生成为 `unknown`。
 */
export function schemaToType(schema: CodemodeJsonSchema, options: { maxChars?: number } = {}): string {
	const type = toType(schema, { root: schema, resolving: new Set(), expansions: 0 });
	return options.maxChars !== undefined && type.length > options.maxChars ? "unknown" : type;
}

interface SchemaContext {
	root: CodemodeJsonSchema;
	/** 当前递归路径中正在展开的引用，用于在遇到递归类型时停止展开。 */
	resolving: Set<string>;
	expansions: number;
}

function resolveRef(ref: string, root: CodemodeJsonSchema): CodemodeJsonSchema | undefined {
	if (ref !== "#" && !ref.startsWith("#/")) return undefined;
	let current: unknown = root;
	for (const segment of ref.slice(2).split("/").filter(Boolean)) {
		const key = decodeURIComponent(segment).replaceAll("~1", "/").replaceAll("~0", "~");
		if (!isObject(current) || !(key in current)) return undefined;
		current = current[key];
	}
	return typeof current === "boolean" || isObject(current) ? current : undefined;
}

function toType(schema: CodemodeJsonSchema, context: SchemaContext): string {
	if (schema === true) return "unknown";
	if (schema === false) return "never";
	if (!isObject(schema)) return "unknown";
	if (typeof schema.$ref === "string") {
		const ref = schema.$ref;
		if (context.resolving.has(ref) || context.expansions >= MAX_REF_EXPANSIONS) return "unknown";
		const target = resolveRef(ref, context.root);
		if (target === undefined) return "unknown";
		context.expansions++;
		context.resolving.add(ref);
		try {
			return toType(target, context);
		} finally {
			context.resolving.delete(ref);
		}
	}

	if ("const" in schema) return JSON.stringify(schema.const) ?? "unknown";
	if (Array.isArray(schema.enum)) return union(schema.enum.map((value) => JSON.stringify(value) ?? "unknown"));

	const variants = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : undefined;
	if (variants) return union(variants.map((variant) => toType(variant as CodemodeJsonSchema, context)));
	if (Array.isArray(schema.allOf)) {
		const parts = schema.allOf
			.map((part) => toType(part as CodemodeJsonSchema, context))
			.filter((part) => part !== "unknown");
		return parts.length === 0
			? "unknown"
			: parts.map((part) => (part.includes(" | ") ? `(${part})` : part)).join(" & ");
	}

	const type = schema.type;
	if (Array.isArray(type)) return union(type.map((entry) => toType({ ...schema, type: entry }, context)));
	switch (type) {
		case "string":
			return "string";
		case "number":
		case "integer":
			return "number";
		case "boolean":
			return "boolean";
		case "null":
			return "null";
		case "array":
			return arrayType(schema, context);
		case "object":
			return objectType(schema, context);
		case undefined:
			if ("properties" in schema || "additionalProperties" in schema || "required" in schema) {
				return objectType(schema, context);
			}
			if ("items" in schema || "prefixItems" in schema) return arrayType(schema, context);
			return "unknown";
		default:
			return "unknown";
	}
}

function arrayType(schema: Record<string, unknown>, context: SchemaContext): string {
	if (schema.items !== undefined && !Array.isArray(schema.items)) {
		return `Array<${toType(schema.items as CodemodeJsonSchema, context)}>`;
	}
	const tuple = Array.isArray(schema.prefixItems)
		? schema.prefixItems
		: Array.isArray(schema.items)
			? schema.items
			: [];
	if (tuple.length > 0) return `[${tuple.map((item) => toType(item as CodemodeJsonSchema, context)).join(", ")}]`;
	return "unknown[]";
}

function descriptionOf(property: unknown): string {
	return isObject(property) && typeof property.description === "string" ? property.description.trim() : "";
}

function objectType(schema: Record<string, unknown>, context: SchemaContext): string {
	const properties = isObject(schema.properties) ? schema.properties : {};
	const required = new Set(Array.isArray(schema.required) ? schema.required : []);
	const names = Object.keys(properties).sort();
	const members = names.map((name) => {
		const optional = required.has(name) ? "" : "?";
		return `${propertyKey(name)}${optional}: ${toType(properties[name] as CodemodeJsonSchema, context)};`;
	});
	const additional = schema.additionalProperties;
	if (additional !== undefined && additional !== false) {
		const type = additional === true ? "unknown" : toType(additional as CodemodeJsonSchema, context);
		members.push(`[key: string]: ${type};`);
	} else if (additional === undefined && names.length === 0) {
		members.push("[key: string]: unknown;");
	}
	if (members.length === 0) return "{}";
	if (!names.some((name) => descriptionOf(properties[name]))) return `{ ${members.join(" ")} }`;

	const lines = ["{"];
	names.forEach((name, index) => {
		for (const line of descriptionOf(properties[name]).split(/\r?\n/)) {
			if (line.trim()) lines.push(`${INDENT}// ${line.trim()}`);
		}
		lines.push(`${INDENT}${members[index].replaceAll("\n", `\n${INDENT}`)}`);
	});
	for (const member of members.slice(names.length)) lines.push(`${INDENT}${member}`);
	lines.push("}");
	return lines.join("\n");
}
