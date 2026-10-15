import type { Message } from "../types.ts";

// Copilot 要求通过 X-Initiator 标明请求由用户还是智能体发起，
// 例如 assistant 或工具消息之后的后续请求属于智能体发起。
export function inferCopilotInitiator(messages: Message[]): "user" | "agent" {
	const last = messages[messages.length - 1];
	return last && last.role !== "user" ? "agent" : "user";
}

// 发送图像时，Copilot 要求提供 Copilot-Vision-Request 标头。
export function hasCopilotVisionInput(messages: Message[]): boolean {
	return messages.some((msg) => {
		if (msg.role === "user" && Array.isArray(msg.content)) {
			return msg.content.some((c) => c.type === "image");
		}
		if (msg.role === "toolResult" && Array.isArray(msg.content)) {
			return msg.content.some((c) => c.type === "image");
		}
		return false;
	});
}

export function buildCopilotDynamicHeaders(params: {
	messages: Message[];
	hasImages: boolean;
}): Record<string, string> {
	const headers: Record<string, string> = {
		"X-Initiator": inferCopilotInitiator(params.messages),
		"Openai-Intent": "conversation-edits",
	};

	if (params.hasImages) {
		headers["Copilot-Vision-Request"] = "true";
	}

	return headers;
}
