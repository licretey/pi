// issues/provider-error-body-passthrough 的回归测试
//
// 代理或网关后的端点返回非 2xx 响应，且 SDK 无法将响应体合并到错误消息时，
// 提供方的 catch 块会丢弃响应体。openai SDK 的 APIError 会将解析后的响应体保存在 `error.error` 中，
// 并生成 `"<status> status code (no body)"` 作为错误消息，因此只读取 `error.message` 的 catch
// 会显示不透明的错误消息，并隐藏网关返回的真实原因。
//
// 此测试通过 OpenRouter 图片提供方（忽略响应体的提供方之一）传递带响应体的 403 APIError，
// 并断言最终 errorMessage 同时包含状态码和响应体中的原因。在提供方的 catch 块读取 SDK 错误响应体之前，
// 此测试预期会失败。

import { describe, expect, it, vi } from "vitest";
import { generateImages } from "../src/images.ts";
import type { ImageModel, ImagesContext } from "../src/types.ts";

// 模拟 openai SDK 的 APIError 结构：当设置了状态码，但解析后的响应体（`error`）为空或尚未解析时，
// makeMessage(status, error, message) 会返回 `"403 status code (no body)"`；解析后的响应体本身保存在 `.error` 中。
class FakeAPIError extends Error {
	status: number;
	error: unknown;
	constructor(status: number, parsedBody: unknown) {
		super(`${status} status code (no body)`);
		this.name = "PermissionDeniedError";
		this.status = status;
		this.error = parsedBody;
	}
}

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: () => {
					const promise = Promise.resolve(undefined) as unknown as {
						withResponse: () => Promise<never>;
					};
					promise.withResponse = async () => {
						// 网关或代理返回 403 时，响应体中包含实际错误原因。
						throw new FakeAPIError(403, { error: "blocked by gateway WAF" });
					};
					return promise;
				},
			},
		};
	}
	return { default: FakeOpenAI };
});

describe("provider error body passthrough", () => {
	it("surfaces the HTTP body reason instead of the opaque SDK message (openrouter images)", async () => {
		const model: ImageModel<"openrouter-images"> = {
			type: "image",
			id: "black-forest-labs/flux.2-pro",
			name: "FLUX.2 Pro",
			api: "openrouter-images",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			input: ["text", "image"],
			output: ["image"],
			cost: { input: 0.015, output: 0.03, cacheRead: 0, cacheWrite: 0 },
		};
		const context: ImagesContext = {
			input: [{ type: "text", text: "Generate a dog" }],
		};

		const output = await generateImages(model, context, { apiKey: "test" });

		expect(output.stopReason).toBe("error");
		// 状态码应显示出来。
		expect(output.errorMessage).toContain("403");
		// 不应让不透明的 SDK 错误消息掩盖响应体中的错误原因。
		expect(output.errorMessage).toContain("blocked by gateway WAF");
		expect(output.errorMessage).not.toBe("403 status code (no body)");
	});
});
