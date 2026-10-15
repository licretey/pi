/**
 * 自定义压缩扩展。
 *
 * 将默认压缩行为替换为对整个上下文的完整摘要。
 * 此扩展不会保留最近 20k 个对话 token，而是：
 * 1. 总结全部消息（messagesToSummarize + turnPrefixMessages）。
 * 2. 完全丢弃旧轮次，只保留摘要。
 *
 * 此示例还演示使用另一个模型（Gemini Flash）生成摘要，
 * 它可能比主要对话模型更便宜或更快。
 *
 * 用法：
 *   pi --extension examples/extensions/custom-compaction.ts
 */

import { uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("session_before_compact", async (event, ctx) => {
		ctx.ui.notify("Custom compaction extension triggered", "info");

		const { preparation, branchEntries: _, signal } = event;
		const { messagesToSummarize, turnPrefixMessages, tokensBefore, firstKeptEntryId, previousSummary } = preparation;

		// 使用 Gemini Flash 生成摘要（比多数对话模型更便宜或更快）。
		const model = ctx.modelRegistry.find("google", "gemini-2.5-flash");
		if (!model) {
			ctx.ui.notify(`Could not find Gemini Flash model, using default compaction`, "warning");
			return;
		}

		// 合并所有消息，以生成完整摘要。
		const allMessages = [...messagesToSummarize, ...turnPrefixMessages];

		ctx.ui.notify(
			`Custom compaction: summarizing ${allMessages.length} messages (${tokensBefore.toLocaleString()} tokens) with ${model.id}...`,
			"info",
		);

		// 将消息转换为易读的文本格式。
		const conversationText = serializeConversation(convertToLlm(allMessages));

		// 如果存在先前摘要，将其作为上下文。
		const previousContext = previousSummary ? `\n\nPrevious session summary for context:\n${previousSummary}` : "";

		// 构造请求，要求生成完整摘要。
		const summaryMessages = [
			{
				role: "user" as const,
				content: [
					{
						type: "text" as const,
						text: `You are a conversation summarizer. Create a comprehensive summary of this conversation that captures:${previousContext}

1. The main goals and objectives discussed
2. Key decisions made and their rationale
3. Important code changes, file modifications, or technical details
4. Current state of any ongoing work
5. Any blockers, issues, or open questions
6. Next steps that were planned or suggested

Be thorough but concise. The summary will replace the ENTIRE conversation history, so include all information needed to continue the work effectively.

Format the summary as structured markdown with clear sections.

<conversation>
${conversationText}
</conversation>`,
					},
				],
				timestamp: Date.now(),
			},
		];

		try {
			// 传入 signal，以响应中止请求（例如用户取消压缩）。
			const response = await ctx.modelRegistry.complete(
				model,
				{ messages: summaryMessages },
				{
					maxTokens: 8192,
					signal,
					cacheRetention: "none",
					sessionId: uuidv7(),
				},
			);

			const summary = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");

			if (!summary.trim()) {
				if (!signal.aborted) ctx.ui.notify("Compaction summary was empty, using default compaction", "warning");
				return;
			}

			// 返回压缩内容；SessionManager 会补充 id/parentId。
			// 使用 preparation 中的 firstKeptEntryId 保留近期消息。
			return {
				compaction: {
					summary,
					firstKeptEntryId,
					tokensBefore,
					usage: response.usage,
				},
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Compaction failed: ${message}`, "error");
			// 出错时回退到默认压缩逻辑。
			return;
		}
	});
}
