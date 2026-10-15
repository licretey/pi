/**
 * 确保所有已配置的 Amazon Bedrock 模型均可用的测试套件。
 *
 * 此测试用于确认从 models.dev 等来源获取的模型标识符正确。
 * Amazon Bedrock 的部分模型要求使用跨区域推理，因此普通模型标识符不一定可用，
 * 需要调整模型标识符以启用跨区域推理。详情参见
 * https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-support.html#inference-profiles-support-system。
 *
 * 默认不启用此测试套件；只有设置 AWS 凭据和 `BEDROCK_EXTENSIVE_MODEL_TEST` 环境变量后才会运行。
 * 测试约需 2 分钟。由于并非所有区域都提供全部模型，建议使用 `us-west-2` 区域以获得较完整的覆盖。
 *
 * 可使用以下命令运行此测试套件：
 * ```bash
 * $ AWS_REGION=us-west-2 BEDROCK_EXTENSIVE_MODEL_TEST=1 AWS_PROFILE=... npm test -- ./test/bedrock-models.test.ts
 * ```
 */

import { describe, expect, it } from "vitest";
import { complete, getModels } from "../src/compat.ts";
import type { Context } from "../src/types.ts";
import { hasBedrockCredentials } from "./bedrock-utils.ts";

describe("Amazon Bedrock Models", () => {
	const models = getModels("amazon-bedrock");

	it("should get all available Bedrock models", () => {
		expect(models.length).toBeGreaterThan(0);
		console.log(`Found ${models.length} Bedrock models`);
	});

	it("exposes Claude Opus 5 through an inference profile only", () => {
		expect(models.some((model) => model.id === "global.anthropic.claude-opus-5")).toBe(true);
		expect(models.some((model) => model.id === "anthropic.claude-opus-5")).toBe(false);
	});

	if (hasBedrockCredentials() && process.env.BEDROCK_EXTENSIVE_MODEL_TEST) {
		for (const model of models) {
			it(`should make a simple request with ${model.id}`, { timeout: 10_000 }, async () => {
				const context: Context = {
					systemPrompt: "You are a helpful assistant. Be extremely concise.",
					messages: [
						{
							role: "user",
							content: "Reply with exactly: 'OK'",
							timestamp: Date.now(),
						},
					],
				};

				const response = await complete(model, context);

				expect(response.role).toBe("assistant");
				expect(response.content).toBeTruthy();
				expect(response.content.length).toBeGreaterThan(0);
				expect(response.usage.input + response.usage.cacheRead).toBeGreaterThan(0);
				expect(response.usage.output).toBeGreaterThan(0);
				expect(response.errorMessage).toBeFalsy();

				const textContent = response.content
					.filter((b) => b.type === "text")
					.map((b) => (b.type === "text" ? b.text : ""))
					.join("")
					.trim();
				expect(textContent).toBeTruthy();
				console.log(`${model.id}: ${textContent.substring(0, 100)}`);
			});
		}
	}
});
