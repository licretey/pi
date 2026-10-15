/**
 * `codemode` 工具：模型编写 JavaScript 来调用其他工具。脚本可使用 `tools`、
 * `ALL_TOOLS`、`text()`、`image()`、`exit()`、`store()`/`load()`、`console.*` 和 `return <value>`，
 * 也可在开头添加 `// @options:` 行，并通过 `models.*` 访问模型目录、分类器和图像模型。
 * 结果以 "Script completed" 或 "Script failed" 标题开头。
 *
 * 脚本可以调用 agent 循环中的嵌套工具：当前启用的 `direct` 工具，以及所有 `codemode` 或
 * `deferred` 工具。嵌套调用会经过 agent 循环的工具处理管线（`ctx.executeTool`），因此与直接调用一样，
 * 会执行校验、`tool_call`/`tool_result` 钩子和权限检查。只有脚本输出会传给模型，嵌套调用结果不会。
 *
 * 嵌套调用结果按以下规则传给脚本：
 * - 声明了 `outputSchema` 的工具返回其 `structuredContent`，包含带有该字段的错误结果
 *  （MCP 工具返回其 `CallToolResult`，包括 `isError`）。
 * - 其他工具将文本内容合并为一个字符串返回。
 * - 调用失败、被阻止或参数无效时，会以包含工具错误文本的 Error 拒绝。
 *
 * 脚本失败时仍会返回普通错误结果并保留部分输出，随后附上 "Script error:" 和错误信息。
 * `store(key, value)` 和 `load(key)` 会在多次调用间保存 JSON 值；脚本成功后，其写入会作为
 * `codemode-store` 自定义条目追加到会话中，因此每个分支只会看到自身路径上写入的值。
 */

import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { CodemodeJsonSchema, CodemodeTool } from "@earendil-works/pi-codemode";
import {
	MCP_TYPESCRIPT_PREAMBLE,
	mcpStructuredContentSchema,
	renderToolOutputType,
	renderToolSample,
	toCodemodeIdentifier,
} from "@earendil-works/pi-codemode/declarations";
import { CODEMODE_SOURCE_GRAMMAR } from "@earendil-works/pi-codemode/source";
import { type Static, Type } from "typebox";
import { getDocsPath } from "../../config.ts";
import type {
	ToolDefinition,
	ToolInfo,
	ToolLoadout,
	ToolLoadoutChanges,
	ToolNamespace,
} from "../../core/extensions/types.ts";
import type { ModelRegistry } from "../../core/model-registry.ts";
import { SETTINGS_DEFAULTS } from "../../core/settings-defaults.ts";
import type { CodemodeMode } from "../../core/settings-manager.ts";
import { wrapToolDefinition } from "../../core/tools/tool-definition-wrapper.ts";
import { loadCodemodeExecutor } from "./execute.lazy.ts";
import { codemodeRenderers } from "./renderer.ts";

export const CODEMODE_TOOL_NAME = "codemode";

/** 保存单次脚本 `store()` 写入的自定义条目类型：{@link CodemodeStoreEntryData}。 */
export const CODEMODE_STORE_ENTRY_TYPE = "codemode-store";

export interface CodemodeStoreEntryData {
	set: Record<string, unknown>;
	delete: string[];
}

/** 脚本通过 `models` 访问的模型注册表接口。 */
export type CodemodeModelRuntime = Pick<
	ModelRegistry,
	"getModelsOfType" | "getAvailableOfType" | "getModelOfType" | "classify" | "generateImages"
>;

export interface CodemodeToolOptions {
	/** 工具所属的命名空间，供 `searchTools()` 排序及其 `namespace` 过滤器使用。 */
	getToolNamespace?: (toolName: string) => ToolNamespace | undefined;
	/** 按工具名索引的提示指南；`describeTool()` 和 `ALL_TOOLS` 会将其与声明一起展示。 */
	getToolGuidelines?: () => ReadonlyMap<string, readonly string[]>;
	/**
	 * 向脚本公开 `models` 命名空间，由会话的模型注册表（`ctx.modelRegistry`）提供数据。
	 * 未提供该注册表时，不会声明 `models`。
	 */
	models?: boolean;
	/**
	 * 将 `store()` 写入持久化为会话自定义条目。未提供此功能时，写入只在当前脚本运行期间有效；
	 * `load()` 仍会读取当前分支中已有的条目。
	 */
	appendEntry?: (customType: string, data: CodemodeStoreEntryData) => void;
	/** 工具启用时如何展示工具集合（`codemode.mode` 设置）。默认值：`on`。 */
	getMode?: () => CodemodeMode;
	/** 描述中工具声明的 token 预算。默认值：{@link DEFAULT_CODEMODE_INLINE_BUDGET}。 */
	getInlineBudget?: () => number | undefined;
}

const TEXT_OUTPUT_SCHEMA: CodemodeJsonSchema = { type: "string" };

export const codemodeSchema = Type.Object({
	code: Type.String({
		description: "Raw JavaScript source.",
	}),
});

export type CodemodeToolInput = Static<typeof codemodeSchema>;

/**
 * 判断已注册工具是否为本包的 `codemode` 工具，而非其他扩展中同名的工具。
 * 通过比较参数 schema 判定；工具定义会按引用传递该 schema。
 */
export function isCodemodeTool(tool: Pick<ToolInfo, "name" | "parameters">): boolean {
	return tool.name === CODEMODE_TOOL_NAME && tool.parameters === codemodeSchema;
}

export type CodemodeNestedCallStatus = "running" | "ok" | "error" | "cancelled";

export interface CodemodeNestedCall {
	/** 嵌套调用的工具调用 ID，格式为 `<codemode call id>/<n>`。 */
	id: string;
	name: string;
	/** 参数的紧凑 JSON 表示，过长时会截断以便显示。 */
	args: string;
	status: CodemodeNestedCallStatus;
	durationMs?: number;
	/** 错误文本，过长时会截断以便显示。 */
	error?: string;
	/** 报告了用量的 `models.*` 调用所产生的美元费用。 */
	cost?: number;
}

export interface CodemodeToolDetails {
	calls: CodemodeNestedCall[];
	/** 输出被截断时，保存完整文本输出的临时文件路径。 */
	fullOutputPath?: string;
}

export const codemodeToolSystemPromptContribution = {
	snippet: "Run JavaScript that calls other tools",
	guidelines: [
		"Use codemode to batch independent tool calls (Promise.allSettled), chain them, or filter large output, instead of many separate calls.",
	],
} as const;

/** 脚本参考文档：全局变量、工具结果、`store()`、`models` API 和各项限制。 */
export const CODEMODE_DOCS_PATH = join(getDocsPath(), "codemode.md");

const DESCRIPTION_INTRO = `Run JavaScript that calls other tools. The input is raw JavaScript (not JSON, no code fence), run as an async function body in a QuickJS sandbox: top-level \`await\` and \`return\` work. No Node, file system, network, or timers.
- \`await tools.<name>({ ...args })\` resolves to a string, or an object if the tool's declaration says so, and rejects with an Error on failure. Calls still running when the script ends are cancelled.
- Optional first line: \`// @options: {"max_output_tokens": 10000, "timeout_ms": 60000}\``;

/** 每个全局变量占一行；详细说明见 {@link CODEMODE_DOCS_PATH}。 */
function describeGlobals(models: boolean): string {
	const lines = [
		"Globals:",
		"- `text(value)`, `image(dataUrlOrImageBlock)`, `console.log(...)`, and top-level `return` add output; `exit()` ends the script. With several text items, each starts with a `==> text N/M <==` line, and `console` lines follow the other output in one `<console_output>` block. `image()` also saves the image to a temp file and the result names its path.",
		"- `store(key, value)` and `load(key)` keep JSON values across codemode calls.",
		"- `ALL_TOOLS`, `await searchTools(query, { limit?, namespace? })`, `await describeTool(name)`, `await describeNamespace(name)`: find unlisted tools, such as MCP tools.",
	];
	if (models) {
		lines.push(`- \`models\`: classifiers and image generation. Read ${CODEMODE_DOCS_PATH} first.`);
	}
	return lines.join("\n");
}

/** {@link CodemodeDescriptionOptions.inlineBudget} 的默认值，单位为估算 token 数。 */
export const DEFAULT_CODEMODE_INLINE_BUDGET = SETTINGS_DEFAULTS.codemode.inlineBudget;
/** 估算工具分区所需 token 数时，每个 token 对应的字符数。 */
const CHARS_PER_TOKEN = 4;

/**
 * 脚本看到的工具信息：工具描述后接提示指南；系统提示只包含已声明工具的提示指南。
 * 未声明输出 schema 的工具返回文本输出。
 */
export function toCodemodeDeclaration(
	tool: AgentTool<any>,
	guidelines: readonly string[] = [],
): Omit<CodemodeTool, "execute"> {
	const bullets = guidelines.flatMap((guideline) => (guideline.trim() ? [`- ${guideline.trim()}`] : []));
	return {
		name: tool.name,
		description: bullets.length > 0 ? `${tool.description.trim()}\n\n${bullets.join("\n")}` : tool.description,
		inputSchema: tool.parameters as CodemodeJsonSchema,
		outputSchema: (tool.outputSchema as CodemodeJsonSchema | undefined) ?? TEXT_OUTPUT_SCHEMA,
	};
}

/** 脚本可调用的工具：传入的所有工具，排除 codemode 工具自身。 */
export function getCodemodeCallableTools(tools: readonly AgentTool<any>[]): AgentTool<any>[] {
	return tools.filter((tool) => tool.name !== CODEMODE_TOOL_NAME);
}

export interface CodemodeDescriptionOptions {
	/** 是否声明 `models` 命名空间；仅适用于创建时提供了模型访问能力的工具。 */
	models?: boolean;
	/** 按工具名称记录各工具的命名空间；同一命名空间的工具会列在同一标题下。 */
	namespaces?: ReadonlyMap<string, ToolNamespace>;
	/** 可以调用但不会连同声明一起列出的工具（`deferred` 暴露方式）。 */
	deferred?: ReadonlySet<string>;
	/** 按工具名记录提示指南，并列在对应工具描述之后。 */
	guidelines?: ReadonlyMap<string, readonly string[]>;
	/**
	 * 工具分区可使用的估算 token 数（字符数 / 4）。超出预算的工具会被省略，与 deferred 工具相同。
	 * 未设置时会列出所有非 deferred 工具。
	 */
	inlineBudget?: number;
}

/** 以 `### \`id\` (\`raw name\`)` 为标题，后接工具描述和声明。 */
function renderToolSection(declaration: Omit<CodemodeTool, "execute">): string {
	const id = toCodemodeIdentifier(declaration.name);
	const heading = id === declaration.name ? `### \`${id}\`` : `### \`${id}\` (\`${declaration.name}\`)`;
	return `${heading}\n${renderToolSample(declaration).trim()}`;
}

interface CatalogEntry {
	name: string;
	section: string;
	cost: number;
}

interface CatalogGroup {
	namespace: ToolNamespace | undefined;
	entries: CatalogEntry[];
}

/**
 * 参考 OpenCode 目录的方式挑选符合预算的工具分区：每一轮中，每个分组（先处理无命名空间的工具，
 * 再按名称处理各命名空间）各加入一个剩余工具中开销最低的工具；下一个工具超出预算的分组退出，
 * 其他分组继续。所有命名空间至少列出一个工具后，才会完整列出任一命名空间。
 */
function selectCatalog(groups: readonly CatalogGroup[], budget: number | undefined): Set<string> {
	if (budget === undefined) return new Set(groups.flatMap((group) => group.entries.map((entry) => entry.name)));
	const queues = groups.map((group) => [...group.entries].sort((a, b) => a.cost - b.cost));
	const shown = new Set<string>();
	let remaining = budget;
	let active = queues.filter((queue) => queue.length > 0);
	while (active.length > 0) {
		active = active.filter((queue) => {
			const next = queue[0];
			if (next.cost > remaining) return false;
			remaining -= next.cost;
			shown.add(next.name);
			queue.shift();
			return queue.length > 0;
		});
	}
	return shown;
}

/**
 * 提供给模型的描述包含：辅助函数列表、查找未列出工具的说明、已列出工具需要时使用的共享 MCP 类型、
 * `models` API，以及按命名空间分组的工具分区。Deferred 工具不会列出，也不会影响描述内容；
 * 因此 MCP 服务器连接或变更工具时，该描述保持不变。工具分区受 `inlineBudget` 限制。
 */
export function createCodemodeDescription(
	tools: readonly AgentTool<any>[],
	options: CodemodeDescriptionOptions = {},
): string {
	const declarations = getCodemodeCallableTools(tools)
		.filter((tool) => !options.deferred?.has(tool.name))
		.map((tool) => toCodemodeDeclaration(tool, options.guidelines?.get(tool.name)));
	const groups = new Map<string, CatalogGroup>([["", { namespace: undefined, entries: [] }]]);
	for (const declaration of declarations) {
		const namespace = options.namespaces?.get(declaration.name);
		const key = namespace ? `ns:${namespace.name}` : "";
		const group = groups.get(key) ?? { namespace, entries: [] };
		groups.set(key, group);
		const section = renderToolSection(declaration);
		group.entries.push({ name: declaration.name, section, cost: Math.ceil(section.length / CHARS_PER_TOKEN) });
	}
	const ordered = [...groups.values()].sort((a, b) =>
		a.namespace === undefined ? -1 : b.namespace === undefined ? 1 : a.namespace.name.localeCompare(b.namespace.name),
	);
	const shown = selectCatalog(ordered, options.inlineBudget);

	const sections = [DESCRIPTION_INTRO, describeGlobals(options.models === true)];
	if (
		declarations.some(
			(declaration) =>
				shown.has(declaration.name) && mcpStructuredContentSchema(declaration.outputSchema) !== undefined,
		)
	) {
		sections.push(`Shared MCP Types:\n\`\`\`ts\n${MCP_TYPESCRIPT_PREAMBLE}\n\`\`\``);
	}
	if (declarations.length === 0) return sections.join("\n\n");

	const toolSections = ["Nested tools:"];
	for (const { namespace, entries } of ordered) {
		const visible = entries.filter((entry) => shown.has(entry.name));
		if (namespace) {
			// 这里只统计因超出预算而未列出的工具。
			const listing =
				visible.length === entries.length
					? ""
					: visible.length === 0
						? " (tools not listed)"
						: " (some tools not listed)";
			const description = namespace.description?.trim();
			toolSections.push(`## ${namespace.name}${listing}${description ? `\n${description}` : ""}`);
		}
		for (const entry of visible) toolSections.push(entry.section);
	}
	sections.push(toolSections.join("\n\n"));
	return sections.join("\n\n");
}

/**
 * 脚本调用结果的一行说明：可以是 `a string`、对象的字段名
 *（`{ output, exit_code, full_output_path? }`），或其他值对应的渲染类型。
 */
function describeOutput(schema: CodemodeJsonSchema | undefined): string {
	const type = renderToolOutputType(schema);
	if (type === "string") return "a string";
	const object = typeof schema === "object" ? schema : undefined;
	const properties = object?.properties;
	if (
		object?.type === "object" &&
		typeof properties === "object" &&
		properties !== null &&
		mcpStructuredContentSchema(schema) === undefined
	) {
		const required = new Set(Array.isArray(object.required) ? object.required : []);
		const fields = Object.keys(properties).map((name) => (required.has(name) ? name : `${name}?`));
		return `\`{ ${fields.join(", ")} }\``;
	}
	return `\`${type.replace(/\s+/g, " ")}\``;
}

/**
 * 先列出已声明工具的描述，再说明脚本如何调用它以及调用结果的形式。
 * 参数就是工具声明的参数，因此不再重复列出。
 */
function describeScriptCall(tool: AgentTool<any>): string {
	return `${tool.description.trim()}\n\nCodemode: \`tools.${toCodemodeIdentifier(tool.name)}(args)\` resolves to ${describeOutput(toCodemodeDeclaration(tool).outputSchema)}.`;
}

/**
 * codemode 工具如何展示已声明且可由脚本调用的工具：
 * - `on`：工具描述会说明脚本如何调用它们；codemode 描述只列出没有 `direct` 暴露方式的可调用工具。
 * - `only`：codemode 描述列出所有可调用工具；请求中会省略当前启用的 `direct` 工具声明。
 *
 * 列出的工具会附带提示指南；系统提示只包含已声明工具的提示指南。
 *
 * 按暴露方式而非当前启用集合决定列表，可使 `tool_search` 加载工具时 codemode 描述保持不变，
 * 避免因工具加载而重新声明 codemode。
 */
function prepareCodemodeLoadout(loadout: ToolLoadout, options: CodemodeToolOptions): ToolLoadoutChanges {
	const mode = options.getMode?.() ?? SETTINGS_DEFAULTS.codemode.mode;
	const isDirect = (tool: AgentTool) => loadout.getExposure(tool.name) === "direct";
	const callable = getCodemodeCallableTools(loadout.callable);
	const callableNames = new Set(callable.map((tool) => tool.name));
	const descriptions: Record<string, string> = {};
	if (mode === "on") {
		for (const tool of loadout.declared) {
			if (callableNames.has(tool.name)) descriptions[tool.name] = describeScriptCall(tool);
		}
	}
	const listed = mode === "only" ? callable : callable.filter((tool) => !isDirect(tool));
	const namespaces = new Map(
		listed.flatMap((tool) => {
			const namespace = loadout.getNamespace(tool.name);
			return namespace ? [[tool.name, namespace] as const] : [];
		}),
	);
	const guidelines = new Map(listed.map((tool) => [tool.name, loadout.getPromptGuidelines(tool.name)] as const));
	descriptions[CODEMODE_TOOL_NAME] = createCodemodeDescription(listed, {
		models: options.models === true,
		namespaces,
		guidelines,
		deferred: new Set(
			listed.filter((tool) => loadout.getExposure(tool.name) === "deferred").map((tool) => tool.name),
		),
		inlineBudget: options.getInlineBudget?.() ?? DEFAULT_CODEMODE_INLINE_BUDGET,
	});
	const declaredNames = new Set(loadout.declared.map((tool) => tool.name));
	return {
		descriptions,
		hiddenDeclarations:
			mode === "only"
				? callable.filter((tool) => isDirect(tool) && declaredNames.has(tool.name)).map((tool) => tool.name)
				: [],
	};
}

export function createCodemodeToolDefinition(
	options: CodemodeToolOptions = {},
): ToolDefinition<typeof codemodeSchema, CodemodeToolDetails | undefined> {
	return {
		name: CODEMODE_TOOL_NAME,
		label: CODEMODE_TOOL_NAME,
		// 工具激活时，会替换为可调用工具的声明。
		description: createCodemodeDescription([], { models: options.models === true }),
		promptSnippet: codemodeToolSystemPromptContribution.snippet,
		promptGuidelines: [...codemodeToolSystemPromptContribution.guidelines],
		parameters: codemodeSchema,
		// 脚本不得启动其他脚本。
		exposure: "model-only",
		prepareLoadout: (loadout) => prepareCodemodeLoadout(loadout, options),
		// 对于具备相应能力的模型，脚本以原始文本形式编写，而不是 JSON 转义字符串。
		constrainedSampling: { type: "grammar", variants: { openai_lark: CODEMODE_SOURCE_GRAMMAR } },
		// 沙箱（worker、QuickJS wasm）在首次调用时加载，而非启动时加载。
		execute: async (toolCallId, params, signal, onUpdate, ctx) =>
			(await loadCodemodeExecutor()).executeCodemode(toolCallId, params, signal, onUpdate, ctx, options),
		...codemodeRenderers,
	};
}

/**
 * 将 codemode 创建为 AgentTool。描述中会列出给定工具；脚本运行时可以调用 agent 循环提供的任意工具。
 */
export function createCodemodeTool(
	tools: readonly AgentTool<any>[] = [],
	options: CodemodeToolOptions = {},
): AgentTool<typeof codemodeSchema> {
	const definition = createCodemodeToolDefinition(options);
	const tool = wrapToolDefinition(definition);
	Object.assign(tool, {
		description: createCodemodeDescription(tools, { models: options.models === true }),
		promptSnippet: definition.promptSnippet,
		promptGuidelines: definition.promptGuidelines,
	});
	return tool;
}
