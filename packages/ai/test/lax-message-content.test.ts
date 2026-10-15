/**
 * Message 类型要求始终提供 `content`，但未经过类型检查的调用方（自定义工具、手动构造的历史记录、旧会话文件）
 * 可能违反此约定。`transformMessages` 是所有提供方请求前的统一处理入口，因此有意采用宽松规则：
 * 将为 null 或缺失的内容规范化为空数组（问题 #6259、#6276）。
 */

import { describe, expect, it } from "vitest";
import { transformMessages } from "../src/api/transform-messages.ts";
import type { Message, Model } from "../src/types.ts";

// 使用纯文本模型以触发图像降级路径（replaceImagesWithPlaceholder）；
// 工具结果内容为 null 时，主要会在此路径发生崩溃。
function makeTextOnlyModel(): Model<"openai-completions"> {
	return {
		id: "test-model",
		name: "Test Model",
		api: "openai-completions",
		provider: "openai",
		baseUrl: "https://example.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16000,
	};
}

describe("lax message content handling", () => {
	it("normalizes null/missing content to an empty array instead of crashing", () => {
		const messages = [
			{ role: "user", content: null, timestamp: Date.now() },
			{
				role: "assistant",
				content: null,
				api: "openai-completions",
				provider: "openai",
				model: "test-model",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
			{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "web_search",
				isError: false,
				timestamp: Date.now(),
			},
		] as unknown as Message[];

		const result = transformMessages(messages, makeTextOnlyModel());

		expect(result).toHaveLength(3);
		for (const msg of result) {
			expect(msg.content).toEqual([]);
		}
	});
});
