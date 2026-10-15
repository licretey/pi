import { describe, expect, it } from "vitest";
import { streamSimple } from "../src/api/mistral-conversations.ts";
import type { Context, Model, SimpleStreamOptions, ThinkingLevelMap } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

interface MistralPayload {
	promptMode?: "reasoning";
	reasoningEffort?: string;
	promptCacheKey?: string;
}

const NONE_HIGH_LEVELS: ThinkingLevelMap = {
	off: "none",
	minimal: null,
	low: null,
	medium: null,
	high: "high",
	xhigh: null,
	max: null,
};
const GLM_5_2_LEVELS: ThinkingLevelMap = { ...NONE_HIGH_LEVELS, max: "max" };
const GLM_5_3_LEVELS: ThinkingLevelMap = { ...NONE_HIGH_LEVELS, off: null, low: "low", max: "max" };

function makeModel(
	id: string,
	reasoning: boolean,
	thinkingLevelMap?: ThinkingLevelMap,
): Model<"mistral-conversations"> {
	return {
		id,
		name: id,
		api: "mistral-conversations",
		provider: "mistral",
		baseUrl: "http://127.0.0.1:9",
		reasoning,
		...(thinkingLevelMap ? { thinkingLevelMap } : {}),
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	};
}

function makeContext(): Context {
	return {
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};
}

async function capturePayload(
	model: Model<"mistral-conversations">,
	options?: SimpleStreamOptions,
): Promise<MistralPayload> {
	let capturedPayload: MistralPayload | undefined;
	const stream = streamSimple(model, normalizeContext(makeContext()), {
		...options,
		apiKey: "fake-key",
		onPayload: (payload) => {
			capturedPayload = payload as MistralPayload;
			return payload;
		},
	});

	await stream.result();

	if (!capturedPayload) {
		throw new Error("Expected payload to be captured before request failure");
	}

	return capturedPayload;
}

describe("Mistral reasoning mode selection", () => {
	it("uses prompt_mode for reasoning models without a thinking level map (Magistral)", async () => {
		const payload = await capturePayload(makeModel("magistral-medium-latest", true), { reasoning: "medium" });

		expect(payload.promptMode).toBe("reasoning");
		expect(payload.reasoningEffort).toBeUndefined();
	});

	it("omits reasoning controls for Magistral when thinking is off", async () => {
		const payload = await capturePayload(makeModel("magistral-medium-latest", true));

		expect(payload.promptMode).toBeUndefined();
		expect(payload.reasoningEffort).toBeUndefined();
	});

	// #8700 和 #9375 回归测试：Medium 和 GLM-5.2 会忽略 Magistral 的 prompt_mode。
	describe.each(["mistral-small-2603", "mistral-medium-latest", "zai-glm-5-2"] as const)("%s", (modelId) => {
		const map = modelId === "zai-glm-5-2" ? GLM_5_2_LEVELS : NONE_HIGH_LEVELS;

		it("uses reasoning_effort when thinking is enabled", async () => {
			const payload = await capturePayload(makeModel(modelId, true, map), { reasoning: "high" });

			expect(payload.reasoningEffort).toBe("high");
			expect(payload.promptMode).toBeUndefined();
		});

		it("clamps unsupported levels to a supported effort", async () => {
			const payload = await capturePayload(makeModel(modelId, true, map), { reasoning: "low" });

			expect(payload.reasoningEffort).toBe("high");
		});

		it("sends reasoning_effort none when thinking is off", async () => {
			const payload = await capturePayload(makeModel(modelId, true, map));

			expect(payload.reasoningEffort).toBe("none");
			expect(payload.promptMode).toBeUndefined();
		});
	});

	// #9678 回归测试：请求的推理级别必须传递给由 Mistral 托管的 GLM 模型。
	it("sends max for GLM-5.2", async () => {
		const payload = await capturePayload(makeModel("zai-glm-5-2", true, GLM_5_2_LEVELS), { reasoning: "max" });

		expect(payload.reasoningEffort).toBe("max");
	});

	describe("zai-glm-5-3", () => {
		it.each(["low", "high", "max"] as const)("sends reasoning_effort %s", async (level) => {
			const payload = await capturePayload(makeModel("zai-glm-5-3", true, GLM_5_3_LEVELS), { reasoning: level });

			expect(payload.reasoningEffort).toBe(level);
			expect(payload.promptMode).toBeUndefined();
		});

		it("maps medium to high", async () => {
			const payload = await capturePayload(makeModel("zai-glm-5-3", true, GLM_5_3_LEVELS), { reasoning: "medium" });

			expect(payload.reasoningEffort).toBe("high");
		});
	});

	// #8700 回归测试：推理控制项必须符合模型本身的推理能力。
	it("omits reasoning controls for non-reasoning models", async () => {
		const payload = await capturePayload(makeModel("mistral-medium-2505", false), { reasoning: "medium" });

		expect(payload.reasoningEffort).toBeUndefined();
		expect(payload.promptMode).toBeUndefined();
	});

	it("uses the session id as prompt cache key", async () => {
		const payload = await capturePayload(makeModel("mistral-large-latest", false), {
			sessionId: "session-123",
		});

		expect(payload.promptCacheKey).toBe("session-123");
	});

	it("omits prompt cache key when cache retention is disabled", async () => {
		const payload = await capturePayload(makeModel("mistral-large-latest", false), {
			sessionId: "session-123",
			cacheRetention: "none",
		});

		expect(payload.promptCacheKey).toBeUndefined();
	});
});
