import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { getModel, streamSimple } from "@earendil-works/pi-ai/compat";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import {
	defaultModelPerProvider,
	findInitialModel,
	parseModelPattern,
	resolveCliModel,
	resolveModelScope,
	resolveModelScopeWithDiagnostics,
} from "../src/core/model-resolver.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

// 用于测试的模拟模型。
const mockModels: Model<"anthropic-messages">[] = [
	{
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200000,
		maxTokens: 8192,
	},
	{
		id: "gpt-4o",
		name: "GPT-4o",
		api: "anthropic-messages", // 为简化测试，使用相同的类型。
		provider: "openai",
		baseUrl: "https://api.openai.com",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 5, output: 15, cacheRead: 0.5, cacheWrite: 5 },
		contextWindow: 128000,
		maxTokens: 4096,
	},
];

// 模拟 ID 中包含冒号的 OpenRouter 模型。
const mockOpenRouterModels: Model<"anthropic-messages">[] = [
	{
		id: "qwen/qwen3-coder:exacto",
		name: "Qwen3 Coder Exacto",
		api: "anthropic-messages",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
		contextWindow: 128000,
		maxTokens: 8192,
	},
	{
		id: "openai/gpt-4o:extended",
		name: "GPT-4o Extended",
		api: "anthropic-messages",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 5, output: 15, cacheRead: 0.5, cacheWrite: 5 },
		contextWindow: 128000,
		maxTokens: 4096,
	},
];

const allModels = [...mockModels, ...mockOpenRouterModels];

describe("parseModelPattern", () => {
	describe("simple patterns without colons", () => {
		test("exact match returns model with undefined thinking level", () => {
			const result = parseModelPattern("claude-sonnet-4-5", allModels);
			expect(result.model?.id).toBe("claude-sonnet-4-5");
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.warning).toBeUndefined();
		});

		test("partial match returns best model with undefined thinking level", () => {
			const result = parseModelPattern("sonnet", allModels);
			expect(result.model?.id).toBe("claude-sonnet-4-5");
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.warning).toBeUndefined();
		});

		test("no match returns undefined model and thinking level", () => {
			const result = parseModelPattern("nonexistent", allModels);
			expect(result.model).toBeUndefined();
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.warning).toBeUndefined();
		});
	});

	describe("patterns with valid thinking levels", () => {
		test("sonnet:high returns sonnet with high thinking level", () => {
			const result = parseModelPattern("sonnet:high", allModels);
			expect(result.model?.id).toBe("claude-sonnet-4-5");
			expect(result.thinkingLevel).toBe("high");
			expect(result.warning).toBeUndefined();
		});

		test("gpt-4o:medium returns gpt-4o with medium thinking level", () => {
			const result = parseModelPattern("gpt-4o:medium", allModels);
			expect(result.model?.id).toBe("gpt-4o");
			expect(result.thinkingLevel).toBe("medium");
			expect(result.warning).toBeUndefined();
		});

		test("all valid thinking levels work", () => {
			for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
				const result = parseModelPattern(`sonnet:${level}`, allModels);
				expect(result.model?.id).toBe("claude-sonnet-4-5");
				expect(result.thinkingLevel).toBe(level);
				expect(result.warning).toBeUndefined();
			}
		});
	});

	describe("patterns with invalid thinking levels", () => {
		test("sonnet:random returns sonnet with undefined thinking level and warning", () => {
			const result = parseModelPattern("sonnet:random", allModels);
			expect(result.model?.id).toBe("claude-sonnet-4-5");
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.warning).toContain("Invalid thinking level");
			expect(result.warning).toContain("random");
		});

		test("gpt-4o:invalid returns gpt-4o with undefined thinking level and warning", () => {
			const result = parseModelPattern("gpt-4o:invalid", allModels);
			expect(result.model?.id).toBe("gpt-4o");
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.warning).toContain("Invalid thinking level");
		});
	});

	describe("OpenRouter models with colons in IDs", () => {
		test("qwen3-coder:exacto matches the model with undefined thinking level", () => {
			const result = parseModelPattern("qwen/qwen3-coder:exacto", allModels);
			expect(result.model?.id).toBe("qwen/qwen3-coder:exacto");
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.warning).toBeUndefined();
		});

		test("openrouter/qwen/qwen3-coder:exacto matches with provider prefix", () => {
			const result = parseModelPattern("openrouter/qwen/qwen3-coder:exacto", allModels);
			expect(result.model?.id).toBe("qwen/qwen3-coder:exacto");
			expect(result.model?.provider).toBe("openrouter");
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.warning).toBeUndefined();
		});

		test("qwen3-coder:exacto:high matches model with high thinking level", () => {
			const result = parseModelPattern("qwen/qwen3-coder:exacto:high", allModels);
			expect(result.model?.id).toBe("qwen/qwen3-coder:exacto");
			expect(result.thinkingLevel).toBe("high");
			expect(result.warning).toBeUndefined();
		});

		test("openrouter/qwen/qwen3-coder:exacto:high matches with provider and thinking level", () => {
			const result = parseModelPattern("openrouter/qwen/qwen3-coder:exacto:high", allModels);
			expect(result.model?.id).toBe("qwen/qwen3-coder:exacto");
			expect(result.model?.provider).toBe("openrouter");
			expect(result.thinkingLevel).toBe("high");
			expect(result.warning).toBeUndefined();
		});

		test("gpt-4o:extended matches the extended model with undefined thinking level", () => {
			const result = parseModelPattern("openai/gpt-4o:extended", allModels);
			expect(result.model?.id).toBe("openai/gpt-4o:extended");
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.warning).toBeUndefined();
		});
	});

	describe("invalid thinking levels with OpenRouter models", () => {
		test("qwen3-coder:exacto:random returns model with undefined thinking level and warning", () => {
			const result = parseModelPattern("qwen/qwen3-coder:exacto:random", allModels);
			expect(result.model?.id).toBe("qwen/qwen3-coder:exacto");
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.warning).toContain("Invalid thinking level");
			expect(result.warning).toContain("random");
		});

		test("qwen3-coder:exacto:high:random returns model with undefined thinking level and warning", () => {
			const result = parseModelPattern("qwen/qwen3-coder:exacto:high:random", allModels);
			expect(result.model?.id).toBe("qwen/qwen3-coder:exacto");
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.warning).toContain("Invalid thinking level");
			expect(result.warning).toContain("random");
		});
	});

	describe("edge cases", () => {
		test("empty pattern matches via partial matching", () => {
			// 所有模型 ID 都包含空字符串，因此部分匹配仍会找到结果。
			const result = parseModelPattern("", allModels);
			expect(result.model).not.toBeNull();
			expect(result.thinkingLevel).toBeUndefined();
		});

		test("pattern ending with colon treats empty suffix as invalid", () => {
			const result = parseModelPattern("sonnet:", allModels);
			// 冒号后的空字符串不是有效的思考级别。
			// 因此先尝试匹配 "sonnet:"（不会匹配成功），再尝试匹配 "sonnet"。
			expect(result.model?.id).toBe("claude-sonnet-4-5");
			expect(result.warning).toContain("Invalid thinking level");
		});
	});
});

describe("resolveModelScopeWithDiagnostics", () => {
	test("returns scoped models and structured diagnostics without writing console warnings", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const registry = {
				getAvailable: () => allModels,
			} as unknown as Parameters<typeof resolveModelScopeWithDiagnostics>[1];

			const result = await resolveModelScopeWithDiagnostics(["sonnet:high", "gpt-4o:invalid", "missing"], registry);

			expect(result.scopedModels.map((scoped) => scoped.model.id)).toEqual(["claude-sonnet-4-5", "gpt-4o"]);
			expect(result.scopedModels[0].thinkingLevel).toBe("high");
			expect(result.scopedModels[1].thinkingLevel).toBeUndefined();
			expect(result.diagnostics).toEqual([
				{
					type: "warning",
					message: 'Invalid thinking level "invalid" in pattern "gpt-4o:invalid". Using default instead.',
					code: "invalid-thinking-level",
					pattern: "gpt-4o:invalid",
				},
				{
					type: "warning",
					message: 'No models match pattern "missing"',
					code: "no-match",
					pattern: "missing",
				},
			]);
			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	test("resolveModelScope preserves CLI warning output", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const registry = {
				getAvailable: () => allModels,
			} as unknown as Parameters<typeof resolveModelScope>[1];

			const scopedModels = await resolveModelScope(["missing"], registry);

			expect(scopedModels).toEqual([]);
			expect(warn).toHaveBeenCalledOnce();
			expect(warn.mock.calls[0][0]).toContain('Warning: No models match pattern "missing"');
		} finally {
			warn.mockRestore();
		}
	});

	test("resolves bracketed model ids as exact references before glob matching", async () => {
		const bracketedModel: Model<"anthropic-messages"> = {
			id: "bracketed-model[1m]",
			name: "Bracketed Model",
			api: "anthropic-messages",
			provider: "custom",
			baseUrl: "https://example.invalid",
			reasoning: true,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
			contextWindow: 128000,
			maxTokens: 8192,
		};
		const registry = {
			getAvailable: () => [...allModels, bracketedModel],
		} as unknown as Parameters<typeof resolveModelScopeWithDiagnostics>[1];

		const result = await resolveModelScopeWithDiagnostics(["custom/bracketed-model[1m]"], registry);

		expect(result.scopedModels.map((scoped) => scoped.model.id)).toEqual(["bracketed-model[1m]"]);
		expect(result.diagnostics).toEqual([]);
	});

	test("resolves bracketed model ids with thinking levels as exact references before glob matching", async () => {
		const bracketedModel: Model<"anthropic-messages"> = {
			id: "bracketed-model[1m]",
			name: "Bracketed Model",
			api: "anthropic-messages",
			provider: "custom",
			baseUrl: "https://example.invalid",
			reasoning: true,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
			contextWindow: 128000,
			maxTokens: 8192,
		};
		const registry = {
			getAvailable: () => [...allModels, bracketedModel],
		} as unknown as Parameters<typeof resolveModelScopeWithDiagnostics>[1];

		const result = await resolveModelScopeWithDiagnostics(["custom/bracketed-model[1m]:high"], registry);

		expect(result.scopedModels.map((scoped) => scoped.model.id)).toEqual(["bracketed-model[1m]"]);
		expect(result.scopedModels[0].thinkingLevel).toBe("high");
		expect(result.diagnostics).toEqual([]);
	});
});

describe("resolveCliModel", () => {
	test("resolves --model provider/id without --provider", () => {
		const registry = {
			getModels: () => allModels,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];

		const result = resolveCliModel({
			cliModel: "openai/gpt-4o",
			modelRuntime: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("openai");
		expect(result.model?.id).toBe("gpt-4o");
	});

	test("resolves fuzzy patterns within an explicit provider", () => {
		const registry = {
			getModels: () => allModels,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];

		const result = resolveCliModel({
			cliProvider: "openai",
			cliModel: "4o",
			modelRuntime: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("openai");
		expect(result.model?.id).toBe("gpt-4o");
	});

	test("supports --model <pattern>:<thinking> (without explicit --thinking)", () => {
		const registry = {
			getModels: () => allModels,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];

		const result = resolveCliModel({
			cliModel: "sonnet:high",
			modelRuntime: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.id).toBe("claude-sonnet-4-5");
		expect(result.thinkingLevel).toBe("high");
	});

	test("prefers exact model id match over provider inference (OpenRouter-style ids)", () => {
		const registry = {
			getModels: () => allModels,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];

		const result = resolveCliModel({
			cliModel: "openai/gpt-4o:extended",
			modelRuntime: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("openrouter");
		expect(result.model?.id).toBe("openai/gpt-4o:extended");
	});

	test("does not strip invalid :suffix as thinking level in --model (treat as raw id)", () => {
		const registry = {
			getModels: () => allModels,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];

		const result = resolveCliModel({
			cliProvider: "openai",
			cliModel: "gpt-4o:extended",
			modelRuntime: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("openai");
		expect(result.model?.id).toBe("gpt-4o:extended");
	});

	test("allows custom model ids for explicit providers without double prefixing", () => {
		const registry = {
			getModels: () => allModels,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];

		const result = resolveCliModel({
			cliProvider: "openrouter",
			cliModel: "openrouter/openai/ghost-model",
			modelRuntime: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("openrouter");
		expect(result.model?.id).toBe("openai/ghost-model");
	});

	test("returns a clear error when there are no models", () => {
		const registry = {
			getModels: () => [],
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];

		const result = resolveCliModel({
			cliProvider: "openai",
			cliModel: "gpt-4o",
			modelRuntime: registry,
		});

		expect(result.model).toBeUndefined();
		expect(result.error).toContain("No models available");
	});

	test("prefers the sole authenticated provider for an ambiguous bare exact model id", () => {
		const azureModel: Model<"anthropic-messages"> = {
			...mockModels[1],
			id: "gpt-5.6-sol",
			name: "GPT 5.6 Sol",
			provider: "azure",
		};
		const codexModel: Model<"anthropic-messages"> = {
			...mockModels[1],
			id: "gpt-5.6-sol",
			name: "GPT 5.6 Sol",
			provider: "openai-codex",
		};
		const registry = {
			getModels: () => [azureModel, codexModel],
			hasConfiguredAuth: (provider: string) => provider === "openai-codex",
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];

		const result = resolveCliModel({
			cliModel: "gpt-5.6-sol",
			modelRuntime: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("openai-codex");
		expect(result.model?.id).toBe("gpt-5.6-sol");
	});

	test("requires an explicit provider for an ambiguous bare exact model id without a unique authenticated provider", () => {
		const azureModel: Model<"anthropic-messages"> = {
			...mockModels[1],
			id: "gpt-5.6-sol",
			name: "GPT 5.6 Sol",
			provider: "azure",
		};
		const codexModel: Model<"anthropic-messages"> = {
			...mockModels[1],
			id: "gpt-5.6-sol",
			name: "GPT 5.6 Sol",
			provider: "openai-codex",
		};
		const registry = {
			getModels: () => [azureModel, codexModel],
			hasConfiguredAuth: () => false,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];

		const result = resolveCliModel({
			cliModel: "gpt-5.6-sol",
			modelRuntime: registry,
		});

		expect(result.model).toBeUndefined();
		expect(result.error).toContain('Model "gpt-5.6-sol" is ambiguous across providers');
		expect(result.error).toContain("azure/gpt-5.6-sol");
		expect(result.error).toContain("openai-codex/gpt-5.6-sol");
		expect(result.error).toContain("Use --provider or provider/model");
	});

	test("prefers provider/model split over gateway model with matching id", () => {
		// 用户输入 "zai/glm-5" 时，如果 zai 提供方模型（id: "glm-5"）和
		// 以及网关模型（id: "zai/glm-5"）同时存在时，优先选择 zai 提供方模型。
		const zaiModel: Model<"anthropic-messages"> = {
			id: "glm-5",
			name: "GLM-5",
			api: "anthropic-messages",
			provider: "zai",
			baseUrl: "https://open.bigmodel.cn/api/paas/v4",
			reasoning: true,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
			contextWindow: 128000,
			maxTokens: 8192,
		};
		const gatewayModel: Model<"anthropic-messages"> = {
			id: "zai/glm-5",
			name: "GLM-5",
			api: "anthropic-messages",
			provider: "vercel-ai-gateway",
			baseUrl: "https://ai-gateway.vercel.sh",
			reasoning: true,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
			contextWindow: 128000,
			maxTokens: 8192,
		};
		const registry = {
			getModels: () => [...allModels, zaiModel, gatewayModel],
			hasConfiguredAuth: () => true,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];

		const result = resolveCliModel({
			cliModel: "zai/glm-5",
			modelRuntime: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("zai");
		expect(result.model?.id).toBe("glm-5");
	});

	test("prefers an authenticated exact raw model id over an unauthenticated inferred provider", () => {
		const commandcodeModel: Model<"anthropic-messages"> = {
			id: "xiaomi/mimo-v2.5-pro",
			name: "Xiaomi MiMo via Commandcode",
			api: "anthropic-messages",
			provider: "commandcode",
			baseUrl: "https://example.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
			contextWindow: 128000,
			maxTokens: 8192,
		};
		const xiaomiModel: Model<"anthropic-messages"> = {
			id: "mimo-v2.5-pro",
			name: "Xiaomi MiMo",
			api: "anthropic-messages",
			provider: "xiaomi",
			baseUrl: "https://api.xiaomimimo.com",
			reasoning: false,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
			contextWindow: 128000,
			maxTokens: 8192,
		};
		const registry = {
			getModels: () => [...allModels, commandcodeModel, xiaomiModel],
			hasConfiguredAuth: (provider: string) => provider === "commandcode",
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];

		const result = resolveCliModel({
			cliModel: "xiaomi/mimo-v2.5-pro",
			modelRuntime: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("commandcode");
		expect(result.model?.id).toBe("xiaomi/mimo-v2.5-pro");
	});

	test("resolves provider-prefixed fuzzy patterns (openrouter/qwen -> openrouter model)", () => {
		const registry = {
			getModels: () => allModels,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];

		const result = resolveCliModel({
			cliModel: "openrouter/qwen",
			modelRuntime: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("openrouter");
		expect(result.model?.id).toBe("qwen/qwen3-coder:exacto");
	});

	describe("custom model fallback with :thinking suffix (#5552)", () => {
		// 提供方已注册模型，但指定模型 ID 不在注册表中（会进入 buildFallbackModel 路径）。
		const neuralwattModel: Model<"anthropic-messages"> = {
			id: "some-base-model",
			name: "Some Base Model",
			api: "anthropic-messages",
			provider: "neuralwatt",
			baseUrl: "https://api.neuralwatt.com",
			reasoning: false,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
			contextWindow: 128000,
			maxTokens: 8192,
		};

		const modelsWithNeuralwatt = [...allModels, neuralwattModel];

		test("strips :thinking suffix from custom model id in fallback path", () => {
			const registry = {
				getModels: () => modelsWithNeuralwatt,
			} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];

			const result = resolveCliModel({
				cliModel: "neuralwatt/zai-org/GLM-5.1-FP8:high",
				modelRuntime: registry,
			});

			expect(result.error).toBeUndefined();
			expect(result.model?.provider).toBe("neuralwatt");
			// :high 后缀不得混入发送给 API 的模型 ID。
			expect(result.model?.id).toBe("zai-org/GLM-5.1-FP8");
			expect(result.model?.reasoning).toBe(true);
			expect(result.thinkingLevel).toBe("high");
		});

		test("custom model without thinking suffix works normally in fallback path", () => {
			const registry = {
				getModels: () => modelsWithNeuralwatt,
			} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];

			const result = resolveCliModel({
				cliModel: "neuralwatt/zai-org/GLM-5.1-FP8",
				modelRuntime: registry,
			});

			expect(result.error).toBeUndefined();
			expect(result.model?.provider).toBe("neuralwatt");
			expect(result.model?.id).toBe("zai-org/GLM-5.1-FP8");
			expect(result.thinkingLevel).toBeUndefined();
		});

		test("all valid thinking levels work in fallback path", () => {
			const registry = {
				getModels: () => modelsWithNeuralwatt,
			} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];

			for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
				const result = resolveCliModel({
					cliModel: `neuralwatt/zai-org/GLM-5.1-FP8:${level}`,
					modelRuntime: registry,
				});

				expect(result.error).toBeUndefined();
				expect(result.model?.id).toBe("zai-org/GLM-5.1-FP8");
				expect(result.thinkingLevel).toBe(level);
			}
		});

		test("invalid thinking suffix on custom model is treated as part of model id", () => {
			const registry = {
				getModels: () => modelsWithNeuralwatt,
			} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];

			const result = resolveCliModel({
				cliModel: "neuralwatt/zai-org/GLM-5.1-FP8:banana",
				modelRuntime: registry,
			});

			expect(result.error).toBeUndefined();
			expect(result.model?.provider).toBe("neuralwatt");
			// 无效后缀保留在模型 ID 中（它不是思考级别）。
			expect(result.model?.id).toBe("zai-org/GLM-5.1-FP8:banana");
			expect(result.thinkingLevel).toBeUndefined();
		});

		test("explicit --provider with custom model:thinking strips suffix correctly", () => {
			const registry = {
				getModels: () => modelsWithNeuralwatt,
			} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];

			const result = resolveCliModel({
				cliProvider: "neuralwatt",
				cliModel: "zai-org/GLM-5.1-FP8:high",
				modelRuntime: registry,
			});

			expect(result.error).toBeUndefined();
			expect(result.model?.provider).toBe("neuralwatt");
			expect(result.model?.id).toBe("zai-org/GLM-5.1-FP8");
			expect(result.thinkingLevel).toBe("high");
		});

		test("with explicit --thinking, :suffix is kept as part of model id", () => {
			const registry = {
				getModels: () => modelsWithNeuralwatt,
			} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];

			const result = resolveCliModel({
				cliModel: "neuralwatt/zai-org/GLM-5.1-FP8:high",
				cliThinking: "medium",
				modelRuntime: registry,
			});

			expect(result.error).toBeUndefined();
			expect(result.model?.provider).toBe("neuralwatt");
			// 由于显式指定了 --thinking，:high 会保留为模型 ID 的一部分。
			expect(result.model?.id).toBe("zai-org/GLM-5.1-FP8:high");
			expect(result.thinkingLevel).toBeUndefined();
		});
	});
});

describe("default model selection", () => {
	test("openai defaults track current models", () => {
		expect(defaultModelPerProvider.openai).toBe("gpt-5.5");
		expect(defaultModelPerProvider["openai-codex"]).toBe("gpt-6.1-sol");
	});

	test("zai, minimax, cerebras, and ant-ling defaults track current models", () => {
		expect(defaultModelPerProvider.zai).toBe("glm-5.3");
		expect(defaultModelPerProvider["zai-coding-cn"]).toBe("glm-5.3");
		expect(defaultModelPerProvider.minimax).toBe("MiniMax-M2.7");
		expect(defaultModelPerProvider["minimax-cn"]).toBe("MiniMax-M2.7");
		expect(defaultModelPerProvider.cerebras).toBe("gpt-oss-120b");
		expect(defaultModelPerProvider["ant-ling"]).toBe("Ring-2.6-1T");
	});

	test("built-in chat providers have defaults in their generated catalogs", () => {
		for (const provider of getBuiltinProviders()) {
			const chatModels = getBuiltinModels(provider);
			const defaultId = defaultModelPerProvider[provider];
			if (chatModels.length === 0) {
				expect(defaultId, `${provider} has no chat models and should have no chat default`).toBeUndefined();
				continue;
			}
			expect(
				chatModels.some((model) => model.id === defaultId),
				`${provider} default ${defaultId} should exist in its generated catalog`,
			).toBe(true);
		}
	});

	test("ai-gateway default tracks current model", () => {
		expect(defaultModelPerProvider["vercel-ai-gateway"]).toBe("zai/glm-5.1");
	});

	test("xai default tracks current model", () => {
		expect(defaultModelPerProvider.xai).toBe("grok-4.7");
	});

	test("qwen token plan individual default tracks current model", () => {
		expect(defaultModelPerProvider["qwen-token-plan-individual"]).toBe("qwen3.8-max");
	});

	test("findInitialModel accepts explicit provider custom model ids", async () => {
		const registry = {
			getModels: () => allModels,
		} as unknown as Parameters<typeof findInitialModel>[0]["modelRuntime"];

		const result = await findInitialModel({
			cliProvider: "openrouter",
			cliModel: "openrouter/openai/ghost-model",
			scopedModels: [],
			isContinuing: false,
			modelRuntime: registry,
		});

		expect(result.model?.provider).toBe("openrouter");
		expect(result.model?.id).toBe("openai/ghost-model");
	});

	test("findInitialModel selects ai-gateway default when available", async () => {
		const aiGatewayModel: Model<"anthropic-messages"> = {
			id: "anthropic/claude-opus-4-6",
			name: "Claude Opus 4.6",
			api: "anthropic-messages",
			provider: "vercel-ai-gateway",
			baseUrl: "https://ai-gateway.vercel.sh",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 5, output: 15, cacheRead: 0.5, cacheWrite: 5 },
			contextWindow: 200000,
			maxTokens: 8192,
		};

		const registry = {
			getAvailableSnapshot: () => [aiGatewayModel],
		} as unknown as Parameters<typeof findInitialModel>[0]["modelRuntime"];

		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			modelRuntime: registry,
		});

		expect(result.model?.provider).toBe("vercel-ai-gateway");
		expect(result.model?.id).toBe("anthropic/claude-opus-4-6");
	});

	test("findInitialModel ignores an unauthenticated saved default", async () => {
		const savedDeepSeekModel: Model<"anthropic-messages"> = {
			id: "deepseek-v4-flash",
			name: "DeepSeek V4 Flash",
			api: "anthropic-messages",
			provider: "deepseek",
			baseUrl: "https://api.deepseek.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
			contextWindow: 128000,
			maxTokens: 8192,
		};
		const localDeepSeekModel: Model<"anthropic-messages"> = {
			...savedDeepSeekModel,
			provider: "spark-two",
			baseUrl: "http://spark-two:8000/v1",
		};
		const registry = {
			getModel: (provider: string, modelId: string) =>
				provider === savedDeepSeekModel.provider && modelId === savedDeepSeekModel.id
					? savedDeepSeekModel
					: undefined,
			hasConfiguredAuth: (provider: string) => provider === "spark-two",
			getAvailableSnapshot: () => [localDeepSeekModel],
		} as unknown as Parameters<typeof findInitialModel>[0]["modelRuntime"];

		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			defaultProvider: "deepseek",
			defaultModelId: "deepseek-v4-flash",
			modelRuntime: registry,
		});

		expect(result.model?.provider).toBe("spark-two");
		expect(result.model?.id).toBe("deepseek-v4-flash");
	});

	describe("persisted default model scoping", () => {
		const tempDirs: string[] = [];
		const sonnet = getModel("anthropic", "claude-sonnet-4-5")!;
		const opus = getModel("anthropic", "claude-opus-4-8")!;

		afterEach(() => {
			for (const dir of tempDirs.splice(0)) {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		async function createSession(options: { scoped: boolean; persistedScope?: string[] }) {
			const tempDir = join(tmpdir(), `pi-default-scope-${Date.now()}-${Math.random().toString(36).slice(2)}`);
			mkdirSync(tempDir, { recursive: true });
			tempDirs.push(tempDir);

			const settingsManager = SettingsManager.create(tempDir, tempDir);
			if (options.persistedScope) {
				settingsManager.setEnabledModels(options.persistedScope);
			}

			const authStorage = AuthStorage.inMemory({ anthropic: { type: "api_key", key: "test-key" } });
			const modelRuntime = getModelRuntime(await createModelRegistry(authStorage, join(tempDir, "models.json")));
			const agent = new Agent({
				initialState: {
					model: sonnet,
					systemPrompt: "test",
					tools: [],
				},
				streamFn: streamSimple,
			});
			const session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(tempDir),
				settingsManager,
				cwd: tempDir,
				modelRuntime,
				resourceLoader: createTestResourceLoader(),
				scopedModels: options.scoped ? [{ model: sonnet }] : [],
			});

			return { session, settingsManager };
		}

		test("adds a persisted default to an existing scoped model list", async () => {
			const { session, settingsManager } = await createSession({
				scoped: true,
				persistedScope: [`${sonnet.provider}/${sonnet.id}`],
			});

			await session.setModel(opus, { persist: true });

			expect(settingsManager.getDefaultProvider()).toBe(opus.provider);
			expect(settingsManager.getDefaultModel()).toBe(opus.id);
			expect(session.scopedModels.map((scoped) => `${scoped.model.provider}/${scoped.model.id}`)).toEqual([
				`${sonnet.provider}/${sonnet.id}`,
				`${opus.provider}/${opus.id}`,
			]);
			expect(settingsManager.getEnabledModels()).toEqual([
				`${sonnet.provider}/${sonnet.id}`,
				`${opus.provider}/${opus.id}`,
			]);
		});

		test("does not create a scoped model list when all models are available", async () => {
			const { session, settingsManager } = await createSession({ scoped: false });

			await session.setModel(opus, { persist: true });

			expect(session.scopedModels).toEqual([]);
			expect(settingsManager.getEnabledModels()).toBeUndefined();
		});

		test("keeps session-only model changes out of scope", async () => {
			const { session, settingsManager } = await createSession({
				scoped: true,
				persistedScope: [`${sonnet.provider}/${sonnet.id}`],
			});

			await session.setModel(opus, { persist: false });

			expect(session.scopedModels.map((scoped) => `${scoped.model.provider}/${scoped.model.id}`)).toEqual([
				`${sonnet.provider}/${sonnet.id}`,
			]);
			expect(settingsManager.getEnabledModels()).toEqual([`${sonnet.provider}/${sonnet.id}`]);
		});
	});
});
