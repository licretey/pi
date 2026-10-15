/**
 * 虚拟模型是目录中的条目，会将每个请求路由到一个实体模型。
 *
 * 当前选择（`model_change`、`agent.state.model`、`ctx.model`）可以指向虚拟模型。
 * 路由之后的流程只接触实体模型：由提供商处理其流式响应，并将其记录在助手消息中。虚拟模型不会传递给提供商。
 *
 * 虚拟模型归属一个提供商 ID，但本身并非提供商模型。`ModelRuntime` 会单独保存它们，并通过
 * `withVirtualModels()` 将其添加到提供商目录，因此任何提供商（包括已有实体模型的提供商）都可以列出多个虚拟模型。
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type AnyModel,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	isModelType,
	lazyStream,
	type Message,
	type Model,
	type ModelThinkingLevel,
	type Provider,
	type ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import type { SessionEntry } from "./session-manager.ts";

/** 虚拟目录条目的 API ID；请求必须先完成路由，否则会失败。 */
export const VIRTUAL_MODEL_API = "pi-virtual";

/** 用于在会话分支中保存路由器状态的自定义条目类型。 */
export const VIRTUAL_MODEL_STATE_ENTRY = "pi.virtual-model-state";

/** `pi.virtual-model-state` 自定义条目中的数据。 */
export interface VirtualModelStateData<TState = unknown> {
	provider: string;
	modelId: string;
	state: TState;
}

const THINKING_LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * 请求被路由的原因。
 * - `user`：用户输入消息（提示词、引导内容或后续输入）后的首次请求
 * - `continuation`：代理循环中的其他请求，例如工具结果或扩展消息之后的请求
 * - `retry`：请求失败后的自动重试，包括上下文溢出并压缩后发起的重试
 * - `direct`：代理循环之外的请求，例如压缩摘要或扩展调用
 */
export type ModelRouteReason = "user" | "continuation" | "retry" | "direct";

export interface ModelRouteRequest<TState = unknown> {
	/** 当前选中的虚拟模型。 */
	model: Model<Api>;
	/** 当前选中的思考级别；具体含义由路由器决定。 */
	thinkingLevel: ModelThinkingLevel;
	reason: ModelRouteReason;
	/** `messages` 中最近一次成功响应所使用的实体模型和思考级别。 */
	previous?: { model: Model<Api>; thinkingLevel?: ModelThinkingLevel };
	/**
	 * 对于 `retry`：失败的请求，该请求已不包含在 `messages` 中。`message` 保存其 `stopReason` 和 `errorMessage`。
	 * 若路由器本身失败，则此字段不存在。
	 */
	failed?: { model: Model<Api>; thinkingLevel?: ModelThinkingLevel; message: AssistantMessage };
	/** 此会话分支上路由器最近返回的状态。首次返回状态之前及 `direct` 请求中为 undefined。 */
	state?: TState;
	/** 此请求对应的对话，包含系统消息。 */
	messages: readonly Message[];
	signal?: AbortSignal;
}

/** 单个请求使用的实体模型和思考级别。 */
export interface ModelRoute<TState = unknown> {
	model: Model<Api>;
	thinkingLevel: ModelThinkingLevel;
	/**
	 * 新的路由器状态，除非与 `request.state` 相同，否则会存入会话分支。
	 * 返回 `request.state` 或 undefined 可保留当前状态。该值必须可序列化为 JSON。`direct` 请求会忽略此字段。
	 */
	state?: TState;
}

export interface VirtualModelDefinition<TState = unknown> {
	/** 列出此虚拟模型的提供商。该提供商也可以拥有实体模型。 */
	provider: string;
	/** 模型 ID。不能与 `provider` 的实体模型 ID 相同。 */
	id: string;
	name: string;
	/** 可供选择的思考级别。默认为 `["off"]`。 */
	thinkingLevels?: readonly ModelThinkingLevel[];
	/**
	 * 首次响应前显示的限制。之后，Pi 使用实际作答的实体模型限制。未设置的限制视为未知（0）。
	 */
	contextWindow?: number;
	maxTokens?: number;
	/** 可选择的输入类型。默认为文本和图像；路由到不支持图像的模型时会使用占位内容。 */
	input?: ("text" | "image")[];
	/** 为单个请求选择实体模型和思考级别；所选模型必须已配置凭据。 */
	route(request: ModelRouteRequest<TState>): ModelRoute<TState> | Promise<ModelRoute<TState>>;
}

/** 判断模型或消息是否指向虚拟模型。路由失败时，消息仍保留虚拟模型信息。 */
export function isVirtualModel(model: { api: string }): boolean {
	return model.api === VIRTUAL_MODEL_API;
}

/** 最近一次成功响应。其模型为实体模型；失败或中止的请求（包括路由失败）都会跳过。 */
export function findLatestResponse(messages: readonly AgentMessage[]): AssistantMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted") {
			return message;
		}
	}
	return undefined;
}

/**
 * 会话分支记录的模型选择。虚拟 `model_change` 会一直生效到下一条 `model_change`，因为响应记录的是
 * 它实际路由到的实体模型。其他情况下，以最近一次实体模型响应为准，与未使用虚拟模型的会话相同。
 * 如果虚拟模型已不再注册，则不再沿用该选择，而是回退到最近作答的实体模型。
 *
 * 只有最近一条 `model_change` 可能继续生效，因此最多只需在目录中查找一个模型。
 */
export function getBranchSelection(
	branch: readonly SessionEntry[],
	getModel: (provider: string, modelId: string) => Model<Api> | undefined,
): { provider: string; modelId: string } | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "model_change") {
			return { provider: entry.provider, modelId: entry.modelId };
		}
		if (entry.type === "message" && entry.message.role === "assistant" && !isVirtualModel(entry.message)) {
			const response = { provider: entry.message.provider, modelId: entry.message.model };
			const change = findLastModelChange(branch, i);
			const model = change && getModel(change.provider, change.modelId);
			return change && model && isVirtualModel(model) ? change : response;
		}
	}
	return undefined;
}

function findLastModelChange(
	branch: readonly SessionEntry[],
	before: number,
): { provider: string; modelId: string } | undefined {
	for (let i = before - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "model_change") return { provider: entry.provider, modelId: entry.modelId };
	}
	return undefined;
}

/** 会话分支为虚拟模型保存的最新路由器状态。 */
export function getVirtualModelState(branch: readonly SessionEntry[], provider: string, modelId: string): unknown {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "custom" || entry.customType !== VIRTUAL_MODEL_STATE_ENTRY) continue;
		const data = entry.data as VirtualModelStateData | undefined;
		if (data?.provider === provider && data.modelId === modelId) return data.state;
	}
	return undefined;
}

/** 构造虚拟模型的目录条目。 */
export function createVirtualModel(definition: Omit<VirtualModelDefinition, "route">): Model<Api> {
	const levels = definition.thinkingLevels ?? ["off"];
	const thinkingLevelMap: ThinkingLevelMap = {};
	for (const level of THINKING_LEVELS) thinkingLevelMap[level] = levels.includes(level) ? level : null;
	return {
		id: definition.id,
		name: definition.name,
		api: VIRTUAL_MODEL_API,
		provider: definition.provider,
		baseUrl: "",
		reasoning: levels.some((level) => level !== "off"),
		thinkingLevelMap,
		input: definition.input ?? ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: definition.contextWindow ?? 0,
		maxTokens: definition.maxTokens ?? 0,
	};
}

/** 未经路由的虚拟模型所使用的流，例如带有 API 专属选项的 `stream()` 调用。 */
function unroutedStream(model: Model<Api>): AssistantMessageEventStream {
	return lazyStream(model, async () => {
		throw new Error(`Virtual model ${model.provider}/${model.id} must be routed before streaming`);
	});
}

/**
 * 将虚拟模型添加到提供商目录中。若未指定提供商，则生成一个无密钥提供商，仅列出这些虚拟模型。
 * 虚拟模型会隐藏相同 ID 的实体聊天模型；目录刷新可能会在注册后添加该实体模型。模型是否可用取决于提供商的认证状态。
 */
export function withVirtualModels(
	providerId: string,
	provider: Provider | undefined,
	virtualModels: readonly Model<Api>[],
): Provider {
	if (!provider) {
		return {
			id: providerId,
			name: providerId,
			auth: { apiKey: { name: "Virtual model", resolve: async () => ({ auth: {}, source: "virtual" }) } },
			getModels: () => virtualModels,
			stream: unroutedStream,
			streamSimple: unroutedStream,
		};
	}
	const ids = new Set(virtualModels.map((model) => model.id));
	const physical = <TModel extends AnyModel>(models: readonly TModel[]) =>
		models.filter((model) => !isVirtualModel(model) && !(isModelType(model, "chat") && ids.has(model.id)));
	const virtual = <TModel extends AnyModel>(models: readonly TModel[]) =>
		models.filter((model) => isVirtualModel(model));
	const { filterModels, filterAllModels } = provider;
	return {
		...provider,
		getModels: () => [...physical(provider.getModels()), ...virtualModels],
		getAllModels: () => [...physical(provider.getAllModels?.() ?? provider.getModels()), ...virtualModels],
		filterModels: (models, credential) => {
			const real = physical(models);
			return [...(filterModels?.(real, credential) ?? real), ...virtual(models)];
		},
		filterAllModels:
			filterAllModels &&
			((models, credential) => [...filterAllModels(physical(models), credential), ...virtual(models)]),
		stream: (model, context, options) =>
			isVirtualModel(model) ? unroutedStream(model) : provider.stream(model, context, options),
		streamSimple: (model, context, options) =>
			isVirtualModel(model) ? unroutedStream(model) : provider.streamSimple(model, context, options),
	};
}
