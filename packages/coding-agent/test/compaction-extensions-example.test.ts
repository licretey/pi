/**
 * 验证 extensions.md 中的示例能够通过编译并正常运行。
 */

import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, SessionBeforeCompactEvent, SessionCompactEvent } from "../src/core/extensions/index.ts";

vi.mock("@earendil-works/pi-coding-agent", () => ({
	convertToLlm: (messages: unknown) => messages,
	serializeConversation: () => "conversation",
}));

const { default: customCompactionExtension } = await import("../examples/extensions/custom-compaction.ts");

describe("Documentation example", () => {
	it("custom compaction example should type-check correctly", () => {
		// 这是 extensions.md 中的示例，验证其能够通过编译。
		const exampleExtension = (pi: ExtensionAPI) => {
			pi.on("session_before_compact", async (event: SessionBeforeCompactEvent, ctx) => {
				// 这些内容都应能通过事件访问。
				const { preparation, branchEntries } = event;
				// sessionManager、modelRegistry 和 model 来自 ctx。
				const { sessionManager, modelRegistry } = ctx;
				const { messagesToSummarize, turnPrefixMessages, tokensBefore, firstKeptEntryId, isSplitTurn } =
					preparation;

				// 验证类型。
				expect(Array.isArray(messagesToSummarize)).toBe(true);
				expect(Array.isArray(turnPrefixMessages)).toBe(true);
				expect(typeof isSplitTurn).toBe("boolean");
				expect(typeof tokensBefore).toBe("number");
				expect(typeof sessionManager.getEntries).toBe("function");
				expect(typeof modelRegistry.getApiKeyAndHeaders).toBe("function");
				expect(typeof firstKeptEntryId).toBe("string");
				expect(Array.isArray(branchEntries)).toBe(true);

				const summary = messagesToSummarize
					.filter((m) => m.role === "user")
					.map((m) => `- ${typeof m.content === "string" ? m.content.slice(0, 100) : "[complex]"}`)
					.join("\n");

				// 扩展返回压缩内容，SessionManager 会补充 id/parentId。
				return {
					compaction: {
						summary: `User requests:\n${summary}`,
						firstKeptEntryId,
						tokensBefore,
					},
				};
			});
		};

		// 只验证函数存在且可调用。
		expect(typeof exampleExtension).toBe("function");
	});

	it("custom compaction example dispatches through modelRegistry.complete", async () => {
		let handler: ((event: any, ctx: any) => Promise<any>) | undefined;
		customCompactionExtension({
			on(event, fn) {
				if (event === "session_before_compact") handler = fn as typeof handler;
			},
		} as ExtensionAPI);

		expect(handler).toBeDefined();

		const complete = vi.fn(async () => ({
			role: "assistant",
			content: [{ type: "text", text: "custom provider summary" }],
			provider: "example-custom",
			api: "example-custom-api",
			model: "summary-model",
			stopReason: "stop",
			usage: {
				input: 1,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 3,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		}));
		const model = {
			provider: "example-custom",
			api: "example-custom-api",
			id: "summary-model",
			name: "Summary Model",
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000,
			maxTokens: 100,
		};

		const result = await handler!(
			{
				preparation: {
					messagesToSummarize: [
						{ role: "user", content: [{ type: "text", text: "please remember this" }], timestamp: Date.now() },
					],
					turnPrefixMessages: [],
					tokensBefore: 42,
					firstKeptEntryId: "entry-1",
				},
				branchEntries: [],
				signal: new AbortController().signal,
			},
			{
				ui: { notify: vi.fn() },
				modelRegistry: {
					find: vi.fn(() => model),
					complete,
				},
			},
		);

		expect(complete).toHaveBeenCalledWith(
			model,
			expect.objectContaining({ messages: expect.any(Array) }),
			expect.objectContaining({ maxTokens: 8192 }),
		);
		expect(complete).not.toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.objectContaining({ apiKey: expect.anything() }),
		);
		expect(result).toMatchObject({
			compaction: {
				summary: "custom provider summary",
				firstKeptEntryId: "entry-1",
				tokensBefore: 42,
			},
		});
	});

	it("compact event should have correct fields", () => {
		const checkCompactEvent = (pi: ExtensionAPI) => {
			pi.on("session_compact", async (event: SessionCompactEvent) => {
				// 这些内容都应可访问。
				const entry = event.compactionEntry;
				const fromExtension = event.fromExtension;

				expect(entry.type).toBe("compaction");
				expect(typeof entry.summary).toBe("string");
				expect(typeof entry.tokensBefore).toBe("number");
				expect(typeof fromExtension).toBe("boolean");
			});
		};

		expect(typeof checkCompactEvent).toBe("function");
	});
});
