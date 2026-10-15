/**
 * 模型解析、作用域限定与初始选择
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	type Api,
	type AuthOperationOptions,
	type KnownProvider,
	type Model,
	modelsAreEqual,
} from "@earendil-works/pi-ai";
import chalk from "chalk";
import { minimatch } from "minimatch";
import { isValidThinkingLevel } from "../cli/args.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import type { ModelRuntime } from "./model-runtime.ts";

/** 内置 chat model 的提供商对应的默认 model ID。 */
export const defaultModelPerProvider: Partial<Record<KnownProvider, string>> = {
	"amazon-bedrock": "us.anthropic.claude-opus-4-6-v1",
	"ant-ling": "Ring-2.6-1T",
	anthropic: "claude-opus-4-8",
	openai: "gpt-5.5",
	azure: "gpt-5.4",
	"openai-codex": "gpt-6.1-sol",
	radius: "balanced",
	nvidia: "nvidia/nemotron-3-ultra-550b-a55b",
	deepseek: "deepseek-v4-pro",
	google: "gemini-3.1-pro-preview",
	"google-vertex": "gemini-3.1-pro-preview",
	"github-copilot": "gpt-5.4",
	openrouter: "moonshotai/kimi-k2.6",
	"vercel-ai-gateway": "zai/glm-5.1",
	xai: "grok-4.7",
	groq: "openai/gpt-oss-120b",
	cerebras: "gpt-oss-120b",
	zai: "glm-5.3",
	"zai-coding-cn": "glm-5.3",
	mistral: "devstral-medium-latest",
	minimax: "MiniMax-M2.7",
	"minimax-cn": "MiniMax-M2.7",
	moonshotai: "kimi-k2.6",
	"moonshotai-cn": "kimi-k2.6",
	huggingface: "moonshotai/Kimi-K2.6",
	fireworks: "accounts/fireworks/models/kimi-k3",
	together: "moonshotai/Kimi-K3",
	baseten: "zai-org/GLM-5.2",
	opencode: "kimi-k2.6",
	"opencode-go": "kimi-k3",
	"kimi-coding": "kimi-for-coding",
	meta: "muse-spark-1.3",
	"cloudflare-workers-ai": "@cf/moonshotai/kimi-k2.6",
	"cloudflare-ai-gateway": "workers-ai/@cf/moonshotai/kimi-k2.6",
	"qwen-token-plan": "qwen3.7-max",
	"qwen-token-plan-cn": "qwen3.7-max",
	"qwen-token-plan-individual": "qwen3.8-max",
	xiaomi: "mimo-v2.5-pro",
	"xiaomi-token-plan-cn": "mimo-v2.5-pro",
	"xiaomi-token-plan-ams": "mimo-v2.5-pro",
	"xiaomi-token-plan-sgp": "mimo-v2.5-pro",
};

export interface ScopedModel {
	model: Model<Api>;
	/** 若模式中显式指定了 thinking level（如 "model:high"）则为其值，否则为 undefined */
	thinkingLevel?: ThinkingLevel;
}

/**
 * 辅助函数：判断 model ID 是否像是别名（无日期后缀）
 * 日期通常为 -20241022 或 -20250929 这种格式
 */
function isAlias(id: string): boolean {
	// 检查 ID 是否以 -latest 结尾
	if (id.endsWith("-latest")) return true;

	// 检查 ID 是否以日期模式（-YYYYMMDD）结尾
	const datePattern = /-\d{8}$/;
	return !datePattern.test(id);
}

/**
 * 查找精确匹配的 model 引用。
 * 支持裸 model id，也支持规范的 provider/modelId 引用。
 * 按裸 id 匹配时，跨提供商出现歧义匹配会被拒绝。
 */
export function findExactModelReferenceMatch(
	modelReference: string,
	availableModels: Model<Api>[],
): Model<Api> | undefined {
	const trimmedReference = modelReference.trim();
	if (!trimmedReference) {
		return undefined;
	}

	const normalizedReference = trimmedReference.toLowerCase();

	const canonicalMatches = availableModels.filter(
		(model) => `${model.provider}/${model.id}`.toLowerCase() === normalizedReference,
	);
	if (canonicalMatches.length === 1) {
		return canonicalMatches[0];
	}
	if (canonicalMatches.length > 1) {
		return undefined;
	}

	const slashIndex = trimmedReference.indexOf("/");
	if (slashIndex !== -1) {
		const provider = trimmedReference.substring(0, slashIndex).trim();
		const modelId = trimmedReference.substring(slashIndex + 1).trim();
		if (provider && modelId) {
			const providerMatches = availableModels.filter(
				(model) =>
					model.provider.toLowerCase() === provider.toLowerCase() &&
					model.id.toLowerCase() === modelId.toLowerCase(),
			);
			if (providerMatches.length === 1) {
				return providerMatches[0];
			}
			if (providerMatches.length > 1) {
				return undefined;
			}
		}
	}

	const idMatches = availableModels.filter((model) => model.id.toLowerCase() === normalizedReference);
	return idMatches.length === 1 ? idMatches[0] : undefined;
}

/**
 * 尝试在可用模型列表中为 pattern 匹配一个模型。
 * 返回匹配到的模型，未找到则返回 undefined。
 */
function tryMatchModel(modelPattern: string, availableModels: Model<Api>[]): Model<Api> | undefined {
	const exactMatch = findExactModelReferenceMatch(modelPattern, availableModels);
	if (exactMatch) {
		return exactMatch;
	}

	// 无精确匹配——退回到部分匹配
	const matches = availableModels.filter(
		(m) =>
			m.id.toLowerCase().includes(modelPattern.toLowerCase()) ||
			m.name?.toLowerCase().includes(modelPattern.toLowerCase()),
	);

	if (matches.length === 0) {
		return undefined;
	}

	// 区分别名与带日期的版本
	const aliases = matches.filter((m) => isAlias(m.id));
	const datedVersions = matches.filter((m) => !isAlias(m.id));

	if (aliases.length > 0) {
		// 优先别名——若有多个别名，取排序最高的那个
		aliases.sort((a, b) => b.id.localeCompare(a.id));
		return aliases[0];
	} else {
		// 没有别名，则取最新的带日期版本
		datedVersions.sort((a, b) => b.id.localeCompare(a.id));
		return datedVersions[0];
	}
}

export interface ParsedModelResult {
	model: Model<Api> | undefined;
	/** 若模式中显式指定了 thinking level 则为其值，否则为 undefined */
	thinkingLevel?: ThinkingLevel;
	warning: string | undefined;
}

function buildFallbackModel(provider: string, modelId: string, availableModels: Model<Api>[]): Model<Api> | undefined {
	const providerModels = availableModels.filter((m) => m.provider === provider);
	if (providerModels.length === 0) return undefined;

	const defaultId = defaultModelPerProvider[provider as KnownProvider];
	const baseModel = defaultId
		? (providerModels.find((m) => m.id === defaultId) ?? providerModels[0])
		: providerModels[0];

	return {
		...baseModel,
		id: modelId,
		name: modelId,
	};
}

/**
 * 解析 pattern，提取 model 和 thinking level。
 * 可处理 ID 中含冒号的模型（如 OpenRouter 的 :exacto 后缀）。
 *
 * 算法：
 * 1. 先尝试将完整 pattern 作为一个模型匹配
 * 2. 若找到，以 "off" thinking level 返回
 * 3. 若未找到且含冒号，按最后一个冒号拆分：
 *    - 若后缀是合法的 thinking level，使用它并对前缀递归
 *    - 若后缀不合法，发出警告并以 "off" 对前缀递归
 *
 * @internal 为测试而导出。
 */
export function parseModelPattern(
	pattern: string,
	availableModels: Model<Api>[],
	options?: { allowInvalidThinkingLevelFallback?: boolean },
): ParsedModelResult {
	// 先尝试精确匹配
	const exactMatch = tryMatchModel(pattern, availableModels);
	if (exactMatch) {
		return { model: exactMatch, thinkingLevel: undefined, warning: undefined };
	}

	// 无匹配——若有冒号则尝试按最后一个冒号拆分
	const lastColonIndex = pattern.lastIndexOf(":");
	if (lastColonIndex === -1) {
		// 无冒号，pattern 确实匹配不到任何模型
		return { model: undefined, thinkingLevel: undefined, warning: undefined };
	}

	const prefix = pattern.substring(0, lastColonIndex);
	const suffix = pattern.substring(lastColonIndex + 1);

	if (isValidThinkingLevel(suffix)) {
		// 合法的 thinking level——对前缀递归并使用该级别
		const result = parseModelPattern(prefix, availableModels, options);
		if (result.model) {
			// 仅当内层递归没有产生警告时才使用该 thinking level
			return {
				model: result.model,
				thinkingLevel: result.warning ? undefined : suffix,
				warning: result.warning,
			};
		}
		return result;
	} else {
		// 后缀不合法
		const allowFallback = options?.allowInvalidThinkingLevelFallback ?? true;
		if (!allowFallback) {
			// 严格模式（CLI --model 解析）下，把它当作 model id 的一部分并失败。
			// 这样可以避免意外解析到另一个模型。
			return { model: undefined, thinkingLevel: undefined, warning: undefined };
		}

		// 作用域模式：对前缀递归并发出警告
		const result = parseModelPattern(prefix, availableModels, options);
		if (result.model) {
			return {
				model: result.model,
				thinkingLevel: undefined,
				warning: `Invalid thinking level "${suffix}" in pattern "${pattern}". Using default instead.`,
			};
		}
		return result;
	}
}

/**
 * 将 model pattern 解析为实际的 Model 对象，可附带 thinking level
 * 格式："pattern:level"，其中 :level 可选
 * 对每个 pattern，找出所有匹配的模型并挑选最佳版本：
 * 1. 优先别名（如 claude-sonnet-4-5）而非带日期版本（claude-sonnet-4-5-20250929）
 * 2. 若无别名，取最新的带日期版本
 *
 * 支持 ID 中含冒号的模型（如 OpenRouter 的 model:exacto）。
 * 算法先尝试匹配完整 pattern，再逐步剥离冒号后缀以找到匹配。
 */
export interface ModelScopeDiagnostic {
	type: "warning";
	code: "no-match" | "invalid-thinking-level";
	message: string;
	pattern: string;
}

export interface ResolveModelScopeResult {
	scopedModels: ScopedModel[];
	diagnostics: ModelScopeDiagnostic[];
}

export function resolveModelScopeFromModels(
	patterns: string[],
	models: readonly Model<Api>[],
): ResolveModelScopeResult {
	const availableModels = [...models];
	const scopedModels: ScopedModel[] = [];
	const diagnostics: ModelScopeDiagnostic[] = [];

	for (const pattern of patterns) {
		// 检查 pattern 是否包含 glob 字符
		if (pattern.includes("*") || pattern.includes("?") || pattern.includes("[")) {
			// 提取可选的 thinking level 后缀（如 "provider/*:high"）
			const colonIdx = pattern.lastIndexOf(":");
			let globPattern = pattern;
			let thinkingLevel: ThinkingLevel | undefined;

			if (colonIdx !== -1) {
				const suffix = pattern.substring(colonIdx + 1);
				if (isValidThinkingLevel(suffix)) {
					thinkingLevel = suffix;
					globPattern = pattern.substring(0, colonIdx);
				}
			}

			const exactMatch = findExactModelReferenceMatch(globPattern, availableModels);
			if (exactMatch) {
				if (!scopedModels.find((sm) => modelsAreEqual(sm.model, exactMatch))) {
					scopedModels.push({ model: exactMatch, thinkingLevel });
				}
				continue;
			}

			// 匹配 "provider/modelId" 格式或仅 model ID
			// 这样 "*sonnet*" 不必写成 "anthropic/*sonnet*" 也能匹配
			const matchingModels = availableModels.filter((m) => {
				const fullId = `${m.provider}/${m.id}`;
				return minimatch(fullId, globPattern, { nocase: true }) || minimatch(m.id, globPattern, { nocase: true });
			});

			if (matchingModels.length === 0) {
				diagnostics.push({
					type: "warning",
					code: "no-match",
					message: `No models match pattern "${pattern}"`,
					pattern,
				});
				continue;
			}

			for (const model of matchingModels) {
				if (!scopedModels.find((sm) => modelsAreEqual(sm.model, model))) {
					scopedModels.push({ model, thinkingLevel });
				}
			}
			continue;
		}

		const { model, thinkingLevel, warning } = parseModelPattern(pattern, availableModels);

		if (warning) {
			diagnostics.push({ type: "warning", code: "invalid-thinking-level", message: warning, pattern });
		}

		if (!model) {
			diagnostics.push({
				type: "warning",
				code: "no-match",
				message: `No models match pattern "${pattern}"`,
				pattern,
			});
			continue;
		}

		// 避免重复
		if (!scopedModels.find((sm) => modelsAreEqual(sm.model, model))) {
			scopedModels.push({ model, thinkingLevel });
		}
	}

	return { scopedModels, diagnostics };
}

export async function resolveModelScopeWithDiagnostics(
	patterns: string[],
	modelRuntime: ModelRuntime,
	options?: AuthOperationOptions,
): Promise<ResolveModelScopeResult> {
	return resolveModelScopeFromModels(patterns, await modelRuntime.getAvailable(undefined, options));
}

export async function resolveModelScope(
	patterns: string[],
	modelRuntime: ModelRuntime,
	options?: AuthOperationOptions,
): Promise<ScopedModel[]> {
	const { scopedModels, diagnostics } = await resolveModelScopeWithDiagnostics(patterns, modelRuntime, options);
	for (const diagnostic of diagnostics) {
		console.warn(chalk.yellow(`Warning: ${diagnostic.message}`));
	}
	return scopedModels;
}

export interface ResolveCliModelResult {
	model: Model<Api> | undefined;
	thinkingLevel?: ThinkingLevel;
	warning: string | undefined;
	/**
	 * 适合在 CLI 中显示的错误信息。
	 * 设置了此项时 model 为 undefined。
	 */
	error: string | undefined;
}

/**
 * 从 CLI 标志解析单个 model。
 *
 * 支持：
 * - --provider <provider> --model <pattern>
 * - --model <provider>/<pattern>
 * - 模糊匹配（与 model 作用域限定相同的规则：先精确 id，再部分 id/name）
 *
 * 注意：本函数自身不应用 thinking level，但可能会*解析*并返回
 * "<pattern>:<thinking>" 中的 thinking level，交给调用方去应用。
 */
export function resolveCliModel(options: {
	cliProvider?: string;
	cliModel?: string;
	cliThinking?: ThinkingLevel;
	modelRuntime: ModelRuntime;
}): ResolveCliModelResult {
	const { cliProvider, cliModel, cliThinking, modelRuntime } = options;

	if (!cliModel) {
		return { model: undefined, warning: undefined, error: undefined };
	}

	// 重要：这里要用*所有*模型，而不是仅用已预配置授权的模型。
	// 这样 "--api-key" 才能用于首次设置。
	const availableModels = [...modelRuntime.getModels()];
	if (availableModels.length === 0) {
		return {
			model: undefined,
			warning: undefined,
			error: "No models available. Check your installation or add models to models.json.",
		};
	}

	// 构建提供商规范名查找表（大小写不敏感）
	const providerMap = new Map<string, string>();
	for (const m of availableModels) {
		providerMap.set(m.provider.toLowerCase(), m.provider);
	}

	let provider = cliProvider ? providerMap.get(cliProvider.toLowerCase()) : undefined;
	if (cliProvider && !provider) {
		return {
			model: undefined,
			warning: undefined,
			error: `Unknown provider "${cliProvider}". Use --list-models to see available providers/models.`,
		};
	}

	// 若未显式指定 --provider，先按 "provider/model" 格式解读。
	// 当第一个斜杠前的前缀匹配已知提供商时，优先采用这种解释，
	// 而不是去匹配 ID 中确实含斜杠的模型
	// （例如 "zai/glm-5" 应解析为 provider=zai、model=glm-5，
	// 而不是 vercel-ai-gateway 下 ID 为 "zai/glm-5" 的模型）。
	let pattern = cliModel;
	let inferredProvider = false;

	if (!provider) {
		const slashIndex = cliModel.indexOf("/");
		if (slashIndex !== -1) {
			const maybeProvider = cliModel.substring(0, slashIndex);
			const canonical = providerMap.get(maybeProvider.toLowerCase());
			if (canonical) {
				provider = canonical;
				pattern = cliModel.substring(slashIndex + 1);
				inferredProvider = true;
			}
		}
	}

	// 未从斜杠推断出提供商时，先尝试不依赖提供商推断的精确匹配。
	// 这可以处理 ID 天然含斜杠的模型（如 OpenRouter 风格的 ID）。
	// 裸的精确 ID 可能存在于多个提供商，所以不要按目录顺序挑选。
	// 若只有一个已授权的提供商则优先选它；否则要求显式指定提供商，
	// 避免静默选中一个无法使用的提供商。
	if (!provider) {
		const lower = cliModel.toLowerCase();
		const exactMatches = availableModels.filter(
			(m) => m.id.toLowerCase() === lower || `${m.provider}/${m.id}`.toLowerCase() === lower,
		);
		if (exactMatches.length === 1) {
			return { model: exactMatches[0], warning: undefined, thinkingLevel: undefined, error: undefined };
		}
		if (exactMatches.length > 1) {
			const authenticatedExactMatches = exactMatches.filter((m) => modelRuntime.hasConfiguredAuth(m.provider));
			if (authenticatedExactMatches.length === 1) {
				return {
					model: authenticatedExactMatches[0],
					warning: undefined,
					thinkingLevel: undefined,
					error: undefined,
				};
			}

			const matches = exactMatches
				.map((m) => `${m.provider}/${m.id}`)
				.sort((a, b) => a.localeCompare(b))
				.join(", ");
			const authHint =
				authenticatedExactMatches.length === 0
					? "No matching provider is authenticated."
					: "More than one matching provider is authenticated.";
			return {
				model: undefined,
				warning: undefined,
				thinkingLevel: undefined,
				error: `Model "${cliModel}" is ambiguous across providers: ${matches}. ${authHint} Use --provider or provider/model.`,
			};
		}
	}

	if (cliProvider && provider) {
		// 两者都提供时，容忍 --model <provider>/<pattern> 写法，剥掉提供商前缀
		const prefix = `${provider}/`;
		if (cliModel.toLowerCase().startsWith(prefix.toLowerCase())) {
			pattern = cliModel.substring(prefix.length);
		}
	}

	const candidates = provider ? availableModels.filter((m) => m.provider === provider) : availableModels;
	const { model, thinkingLevel, warning } = parseModelPattern(pattern, candidates, {
		allowInvalidThinkingLevelFallback: false,
	});

	if (model) {
		// 若按提供商推断匹配到了未授权的 provider/model 组合，则优先选择
		// 一条已授权的裸 model-id 精确匹配。这样既保留 "provider/model"
		// 语法在可用时的优先地位，又能处理字面 ID 以已知提供商名开头的模型
		// （例如 commandcode 的模型 id "xiaomi/mimo-v2.5-pro"）。
		if (inferredProvider) {
			const rawExactMatches = availableModels.filter(
				(m) => m.id.toLowerCase() === cliModel.toLowerCase() && !modelsAreEqual(m, model),
			);
			if (rawExactMatches.length > 0 && !modelRuntime.hasConfiguredAuth(model.provider)) {
				const authenticatedRawMatches = rawExactMatches.filter((m) => modelRuntime.hasConfiguredAuth(m.provider));
				if (authenticatedRawMatches.length === 1) {
					return {
						model: authenticatedRawMatches[0],
						thinkingLevel: undefined,
						warning: undefined,
						error: undefined,
					};
				}
			}
		}
		return { model, thinkingLevel, warning, error: undefined };
	}

	// 若从斜杠推断出了提供商但在该提供商下没有匹配，则退回到
	// 在所有模型中把完整输入当作裸 model id 来匹配。
	// 这可以处理 "openai/gpt-4o:extended" 这类 OpenRouter 风格的 ID：
	// "openai" 看起来像提供商，但整个字符串其实是 openrouter 上的 model id。
	if (inferredProvider) {
		const lower = cliModel.toLowerCase();
		const exact = availableModels.find(
			(m) => m.id.toLowerCase() === lower || `${m.provider}/${m.id}`.toLowerCase() === lower,
		);
		if (exact) {
			return { model: exact, warning: undefined, thinkingLevel: undefined, error: undefined };
		}
		// 也用完整输入对所有模型尝试 parseModelPattern
		const fallback = parseModelPattern(cliModel, availableModels, {
			allowInvalidThinkingLevelFallback: false,
		});
		if (fallback.model) {
			return {
				model: fallback.model,
				thinkingLevel: fallback.thinkingLevel,
				warning: fallback.warning,
				error: undefined,
			};
		}
	}

	if (provider) {
		// 在构建 fallback 模型前先从 pattern 解析 thinking level 后缀，
		// 但仅在未显式提供 --thinking 时才解析。
		// 如 "zai-org/GLM-5.1-FP8:high" → modelId="zai-org/GLM-5.1-FP8"，fallbackThinking="high"
		let fallbackPattern = pattern;
		let fallbackThinking: ThinkingLevel | undefined;
		if (!cliThinking) {
			const lastColon = pattern.lastIndexOf(":");
			if (lastColon !== -1) {
				const suffix = pattern.substring(lastColon + 1);
				if (isValidThinkingLevel(suffix)) {
					fallbackPattern = pattern.substring(0, lastColon);
					fallbackThinking = suffix;
				}
			}
		}

		const fallbackModel = buildFallbackModel(provider, fallbackPattern, availableModels);
		if (fallbackModel) {
			const requestedThinking = cliThinking ?? fallbackThinking;
			const model =
				requestedThinking && requestedThinking !== "off" ? { ...fallbackModel, reasoning: true } : fallbackModel;
			const fallbackWarning = warning
				? `${warning} Model "${fallbackPattern}" not found for provider "${provider}". Using custom model id.`
				: `Model "${fallbackPattern}" not found for provider "${provider}". Using custom model id.`;
			return { model, thinkingLevel: fallbackThinking, warning: fallbackWarning, error: undefined };
		}
	}

	const display = provider ? `${provider}/${pattern}` : cliModel;
	return {
		model: undefined,
		thinkingLevel: undefined,
		warning,
		error: `Model "${display}" not found. Use --list-models to see available models.`,
	};
}

export interface InitialModelResult {
	model: Model<Api> | undefined;
	thinkingLevel: ThinkingLevel;
	fallbackMessage: string | undefined;
}

/**
 * 按以下优先级找到初始 model：
 * 1. CLI 参数（provider + model）
 * 2. scoped models 中的第一个模型（非继续/恢复会话时）
 * 3. 从 session 恢复（继续/恢复会话时）
 * 4. settings 中保存的默认值
 * 5. 第一个有有效 API key 的可用模型
 */
export async function findInitialModel(options: {
	cliProvider?: string;
	cliModel?: string;
	scopedModels: ScopedModel[];
	isContinuing: boolean;
	defaultProvider?: string;
	defaultModelId?: string;
	defaultThinkingLevel?: ThinkingLevel;
	modelThinkingLevels?: Record<string, ThinkingLevel>;
	modelRuntime: ModelRuntime;
}): Promise<InitialModelResult> {
	const {
		cliProvider,
		cliModel,
		scopedModels,
		isContinuing,
		defaultProvider,
		defaultModelId,
		defaultThinkingLevel,
		modelThinkingLevels,
		modelRuntime,
	} = options;

	let model: Model<Api> | undefined;
	let thinkingLevel: ThinkingLevel = DEFAULT_THINKING_LEVEL;

	// 1. CLI 参数优先
	if (cliProvider && cliModel) {
		const resolved = resolveCliModel({
			cliProvider,
			cliModel,
			modelRuntime,
		});
		if (resolved.error) {
			console.error(chalk.red(resolved.error));
			process.exit(1);
		}
		if (resolved.model) {
			return { model: resolved.model, thinkingLevel: DEFAULT_THINKING_LEVEL, fallbackMessage: undefined };
		}
	}

	// 2. 使用 scoped models 中的第一个模型（继续/恢复会话时跳过）
	if (scopedModels.length > 0 && !isContinuing) {
		const scopedModel = scopedModels[0];
		const perModel = modelThinkingLevels?.[`${scopedModel.model.provider}/${scopedModel.model.id}`];
		return {
			model: scopedModel.model,
			thinkingLevel: scopedModel.thinkingLevel ?? perModel ?? defaultThinkingLevel ?? DEFAULT_THINKING_LEVEL,
			fallbackMessage: undefined,
		};
	}

	// 3. 若已配置授权，尝试 settings 中保存的默认值。
	if (defaultProvider && defaultModelId) {
		const found = modelRuntime.getModel(defaultProvider, defaultModelId);
		if (found && modelRuntime.hasConfiguredAuth(found.provider)) {
			model = found;
			const perModel = modelThinkingLevels?.[`${defaultProvider}/${defaultModelId}`];
			if (perModel) {
				thinkingLevel = perModel;
			} else if (defaultThinkingLevel) {
				thinkingLevel = defaultThinkingLevel;
			}
			return { model, thinkingLevel, fallbackMessage: undefined };
		}
	}

	// 4. 尝试第一个有有效 API key 的可用模型
	const availableModels = [...modelRuntime.getAvailableSnapshot()];

	if (availableModels.length > 0) {
		// 尝试从已知提供商中找默认模型
		for (const provider of Object.keys(defaultModelPerProvider) as KnownProvider[]) {
			const defaultId = defaultModelPerProvider[provider];
			const match = availableModels.find((m) => m.provider === provider && m.id === defaultId);
			if (match) {
				return { model: match, thinkingLevel: DEFAULT_THINKING_LEVEL, fallbackMessage: undefined };
			}
		}

		// 未找到默认值则用第一个可用模型
		return { model: availableModels[0], thinkingLevel: DEFAULT_THINKING_LEVEL, fallbackMessage: undefined };
	}

	// 5. 未找到模型
	return { model: undefined, thinkingLevel: DEFAULT_THINKING_LEVEL, fallbackMessage: undefined };
}

/**
 * 从 session 恢复模型，失败时回退到可用模型
 */
export async function restoreModelFromSession(
	savedProvider: string,
	savedModelId: string,
	currentModel: Model<Api> | undefined,
	shouldPrintMessages: boolean,
	modelRuntime: ModelRuntime,
): Promise<{ model: Model<Api> | undefined; fallbackMessage: string | undefined }> {
	const restoredModel = modelRuntime.getModel(savedProvider, savedModelId);

	// 检查恢复的模型是否存在且仍配置了授权
	const hasConfiguredAuth = restoredModel ? modelRuntime.hasConfiguredAuth(restoredModel.provider) : false;

	if (restoredModel && hasConfiguredAuth) {
		if (shouldPrintMessages) {
			console.log(chalk.dim(`Restored model: ${savedProvider}/${savedModelId}`));
		}
		return { model: restoredModel, fallbackMessage: undefined };
	}

	// 模型不存在或未配置 API key——回退
	const reason = !restoredModel ? "model no longer exists" : "no auth configured";

	if (shouldPrintMessages) {
		console.error(chalk.yellow(`Warning: Could not restore model ${savedProvider}/${savedModelId} (${reason}).`));
	}

	// 已有当前模型则用它作为回退
	if (currentModel) {
		if (shouldPrintMessages) {
			console.log(chalk.dim(`Falling back to: ${currentModel.provider}/${currentModel.id}`));
		}
		return {
			model: currentModel,
			fallbackMessage: `Could not restore model ${savedProvider}/${savedModelId} (${reason}). Using ${currentModel.provider}/${currentModel.id}.`,
		};
	}

	// 尝试找到任意可用模型
	const availableModels = [...modelRuntime.getAvailableSnapshot()];

	if (availableModels.length > 0) {
		// 尝试从已知提供商中找默认模型
		let fallbackModel: Model<Api> | undefined;
		for (const provider of Object.keys(defaultModelPerProvider) as KnownProvider[]) {
			const defaultId = defaultModelPerProvider[provider];
			const match = availableModels.find((m) => m.provider === provider && m.id === defaultId);
			if (match) {
				fallbackModel = match;
				break;
			}
		}

		// 未找到默认值则用第一个可用模型
		if (!fallbackModel) {
			fallbackModel = availableModels[0];
		}

		if (shouldPrintMessages) {
			console.log(chalk.dim(`Falling back to: ${fallbackModel.provider}/${fallbackModel.id}`));
		}

		return {
			model: fallbackModel,
			fallbackMessage: `Could not restore model ${savedProvider}/${savedModelId} (${reason}). Using ${fallbackModel.provider}/${fallbackModel.id}.`,
		};
	}

	// 没有任何可用模型
	return { model: undefined, fallbackMessage: undefined };
}
