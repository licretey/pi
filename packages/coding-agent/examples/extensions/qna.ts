/**
 * 问答提取扩展：从助手回复中提取问题。
 *
 * 演示“提示词生成器”模式：
 * 1. /qna 命令获取最近一条助手消息
 * 2. 提取过程中显示旋转指示器（并隐藏编辑器）
 * 3. 将提取结果载入编辑器，供用户填写答案
 */

import type { UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";

const SYSTEM_PROMPT = `You are a question extractor. Given text from a conversation, extract any questions that need answering and format them for the user to fill in.

Output format:
- List each question on its own line, prefixed with "Q: "
- After each question, add a blank line for the answer prefixed with "A: "
- If no questions are found, output "No questions found in the last message."

Example output:
Q: What is your preferred database?
A: 

Q: Should we use TypeScript or JavaScript?
A: 

Keep questions in the order they appeared. Be concise.`;

export default function (pi: ExtensionAPI) {
	pi.registerCommand("qna", {
		description: "Extract questions from last assistant message into editor",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("qna requires interactive mode", "error");
				return;
			}

			if (!ctx.model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}

			// 查找当前分支中的最后一条助手消息。
			const branch = ctx.sessionManager.getBranch();
			let lastAssistantText: string | undefined;

			for (let i = branch.length - 1; i >= 0; i--) {
				const entry = branch[i];
				if (entry.type === "message") {
					const msg = entry.message;
					if ("role" in msg && msg.role === "assistant") {
						if (msg.stopReason !== "stop") {
							ctx.ui.notify(`Last assistant message incomplete (${msg.stopReason})`, "error");
							return;
						}
						const textParts = msg.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map((c) => c.text);
						if (textParts.length > 0) {
							lastAssistantText = textParts.join("\n");
							break;
						}
					}
				}
			}

			if (!lastAssistantText) {
				ctx.ui.notify("No assistant messages found", "error");
				return;
			}

			// 显示加载界面并执行提取。
			const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				const loader = new BorderedLoader(tui, theme, `Extracting questions using ${ctx.model!.id}...`);
				loader.onAbort = () => done(null);

				// 执行提取任务。
				const doExtract = async () => {
					const userMessage: UserMessage = {
						role: "user",
						content: [{ type: "text", text: lastAssistantText! }],
						timestamp: Date.now(),
					};

					const response = await ctx.modelRegistry.complete(
						ctx.model!,
						{ systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
						{ signal: loader.signal },
					);

					if (response.stopReason === "aborted") {
						return null;
					}

					return response.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("\n");
				};

				doExtract()
					.then(done)
					.catch(() => done(null));

				return loader;
			});

			if (result === null) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			ctx.ui.setEditorText(result);
			ctx.ui.notify("Questions loaded. Edit and submit when ready.", "info");
		},
	});
}
