import { describe, expect, it } from "vitest";
import { isThinkingPart, retainThoughtSignature } from "../src/api/google-shared.ts";

describe("Google thinking detection (thoughtSignature)", () => {
	it("treats part.thought === true as thinking", () => {
		expect(isThinkingPart({ thought: true, thoughtSignature: undefined })).toBe(true);
		expect(isThinkingPart({ thought: true, thoughtSignature: "opaque-signature" })).toBe(true);
	});

	it("does not treat thoughtSignature alone as thinking", () => {
		// 根据 Google 文档，thoughtSignature 用于上下文重放，可出现在任意 part 类型中。
		// 只有 thought === true 才表示该内容属于思考内容。
		// 参考文档：https://ai.google.dev/gemini-api/docs/thought-signatures
		expect(isThinkingPart({ thought: undefined, thoughtSignature: "opaque-signature" })).toBe(false);
		expect(isThinkingPart({ thought: false, thoughtSignature: "opaque-signature" })).toBe(false);
	});

	it("does not treat empty/missing signatures as thinking if thought is not set", () => {
		expect(isThinkingPart({ thought: undefined, thoughtSignature: undefined })).toBe(false);
		expect(isThinkingPart({ thought: false, thoughtSignature: "" })).toBe(false);
	});

	it("preserves the existing signature when subsequent deltas omit thoughtSignature", () => {
		const first = retainThoughtSignature(undefined, "sig-1");
		expect(first).toBe("sig-1");

		const second = retainThoughtSignature(first, undefined);
		expect(second).toBe("sig-1");

		const third = retainThoughtSignature(second, "");
		expect(third).toBe("sig-1");
	});

	it("updates the signature when a new non-empty signature arrives", () => {
		const updated = retainThoughtSignature("sig-1", "sig-2");
		expect(updated).toBe("sig-2");
	});
});
