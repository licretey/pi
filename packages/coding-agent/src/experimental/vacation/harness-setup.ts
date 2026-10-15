import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { createRegistry, type HarnessSettings, type ModelRef, type Registry } from "@earendil-works/pi-durable";
import { applyHttpProxySettings, configureHttpDispatcher } from "../../core/http-dispatcher.ts";
import { findInitialModel, resolveCliModel } from "../../core/model-resolver.ts";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import { Search, Vacation } from "./vacation.ts";

/** pi 的 HTTP 配置：代理、空闲超时，以及供 fetch 使用的 undici 实例。缺少这些配置时，某些提供商的流会意外中断。 */
export function configureHarnessHttp(settingsManager: SettingsManager): void {
	applyHttpProxySettings(settingsManager.getGlobalSettings().httpProxy);
	configureHttpDispatcher(settingsManager.getHttpIdleTimeoutMs());
}

/** Harness 设置；每次使用时都从 pi 启动时加载的设置中读取。 */
export function createHarnessSettings(settingsManager: SettingsManager): HarnessSettings {
	return {
		get stream() {
			const provider = settingsManager.getProviderRetrySettings();
			const idle = settingsManager.getHttpIdleTimeoutMs();
			return {
				timeoutMs: provider.timeoutMs ?? (idle === 0 ? 2147483647 : idle),
				maxRetryDelayMs: provider.maxRetryDelayMs,
				...(provider.maxRetries === undefined ? {} : { maxRetries: provider.maxRetries }),
			};
		},
		get compaction() {
			return settingsManager.getCompactionSettings();
		},
		get retry() {
			return settingsManager.getRetrySettings();
		},
		get steeringMode() {
			return settingsManager.getSteeringMode();
		},
		get followUpMode() {
			return settingsManager.getFollowUpMode();
		},
	};
}

/** 包含休假规划器及其研究子代理搜索工具的注册表。不包含代码工具或 pi 提示词。 */
export function createVacationRegistry(): Registry {
	const registry = createRegistry();
	registry.install(Vacation);
	registry.install(Search);
	return registry;
}

export interface InitialModel {
	readonly model?: ModelRef;
	readonly thinkingLevel?: ModelThinkingLevel;
	readonly fallbackMessage?: string;
}

/** 新根对话使用的模型：显式指定的 `--provider`/`--model`，或由 pi 按默认规则解析的模型。 */
export async function findInitialAgentModel(
	settingsManager: SettingsManager,
	modelRuntime: ModelRuntime,
	cli?: { readonly provider?: string; readonly model: string },
): Promise<InitialModel> {
	if (cli !== undefined) {
		const resolved = resolveCliModel({ cliProvider: cli.provider, cliModel: cli.model, modelRuntime });
		if (resolved.error !== undefined || resolved.model === undefined) {
			throw new Error(`Could not resolve model: ${resolved.error ?? cli.model}`);
		}
		return {
			model: { provider: resolved.model.provider, modelId: resolved.model.id },
			...(resolved.thinkingLevel === undefined ? {} : { thinkingLevel: resolved.thinkingLevel }),
		};
	}
	const initial = await findInitialModel({
		scopedModels: [],
		isContinuing: false,
		defaultProvider: settingsManager.getDefaultProvider(),
		defaultModelId: settingsManager.getDefaultModel(),
		defaultThinkingLevel: settingsManager.getDefaultThinkingLevel(),
		modelRuntime,
	});
	return {
		...(initial.model === undefined
			? {}
			: {
					model: { provider: initial.model.provider, modelId: initial.model.id },
					thinkingLevel: initial.thinkingLevel,
				}),
		...(initial.fallbackMessage === undefined ? {} : { fallbackMessage: initial.fallbackMessage }),
	};
}
