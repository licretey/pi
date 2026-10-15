/**
 * 发送用户消息示例
 *
 * 演示如何在扩展中使用 pi.sendUserMessage() 发送用户消息。
 * pi.sendMessage() 用于发送自定义消息；sendUserMessage() 则发送真正的用户消息，
 * 消息会像用户亲自输入的一样出现在对话中。
 *
 * 用法：
 *   /ask 2+2 等于多少？   - 发送用户消息（始终触发新一轮）
 *   /steer 关注 X         - 流式生成期间以 steer 方式发送消息
 *   /followup 然后呢？    - 流式生成期间以 followUp 方式发送消息
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	// 发送用户消息的简单命令。
	pi.registerCommand("ask", {
		description: "Send a user message to the agent",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				ctx.ui.notify("Usage: /ask <message>", "warning");
				return;
			}

			// 非流式生成期间，sendUserMessage 始终会触发新一轮。
			// 流式生成期间未指定 deliverAs 时会抛出异常。
			if (!ctx.isIdle()) {
				ctx.ui.notify("Agent is busy. Use /steer or /followup instead.", "warning");
				return;
			}

			pi.sendUserMessage(args);
		},
	});

	// 在对话过程中引导智能体的命令。
	pi.registerCommand("steer", {
		description: "Send a steering message (interrupts current processing)",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				ctx.ui.notify("Usage: /steer <message>", "warning");
				return;
			}

			if (ctx.isIdle()) {
				// 当前没有流式生成，直接正常发送。
				pi.sendUserMessage(args);
			} else {
				// 正在流式生成，使用 steer 中断当前生成。
				pi.sendUserMessage(args, { deliverAs: "steer" });
			}
		},
	});

	// 将后续消息加入队列的命令。
	pi.registerCommand("followup", {
		description: "Queue a follow-up message (waits for current processing)",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				ctx.ui.notify("Usage: /followup <message>", "warning");
				return;
			}

			if (ctx.isIdle()) {
				// 当前没有流式生成，直接正常发送。
				pi.sendUserMessage(args);
			} else {
				// 正在流式生成，将消息作为后续内容排队。
				pi.sendUserMessage(args, { deliverAs: "followUp" });
				ctx.ui.notify("Follow-up queued", "info");
			}
		},
	});

	// 内容数组示例（此处也可以包含文本和图像）。
	pi.registerCommand("askwith", {
		description: "Send a user message with structured content",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				ctx.ui.notify("Usage: /askwith <message>", "warning");
				return;
			}

			if (!ctx.isIdle()) {
				ctx.ui.notify("Agent is busy", "warning");
				return;
			}

			// sendUserMessage 接受字符串或 (TextContent | ImageContent)[]。
			pi.sendUserMessage([
				{ type: "text", text: `User request: ${args}` },
				{ type: "text", text: "Please respond concisely." },
			]);
		},
	});
}
