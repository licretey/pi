import type {
	Api,
	AssistantMessage,
	ImageContent,
	Message,
	Model,
	TextContent,
	ToolCall,
	ToolResultMessage,
} from "../types.ts";

const NON_VISION_USER_IMAGE_PLACEHOLDER = "(image omitted: model does not support images)";
const NON_VISION_TOOL_IMAGE_PLACEHOLDER = "(tool image omitted: model does not support images)";

function replaceImagesWithPlaceholder(content: (TextContent | ImageContent)[], placeholder: string): TextContent[] {
	const result: TextContent[] = [];
	let previousWasPlaceholder = false;

	for (const block of content) {
		if (block.type === "image") {
			if (!previousWasPlaceholder) {
				result.push({ type: "text", text: placeholder });
			}
			previousWasPlaceholder = true;
			continue;
		}

		result.push(block);
		previousWasPlaceholder = block.text === placeholder;
	}

	return result;
}

function downgradeUnsupportedImages<TApi extends Api>(messages: Message[], model: Model<TApi>): Message[] {
	if (model.input.includes("image")) {
		return messages;
	}

	return messages.map((msg) => {
		if (msg.role === "user" && Array.isArray(msg.content)) {
			return {
				...msg,
				content: replaceImagesWithPlaceholder(msg.content, NON_VISION_USER_IMAGE_PLACEHOLDER),
			};
		}

		if (msg.role === "toolResult") {
			return {
				...msg,
				content: replaceImagesWithPlaceholder(msg.content, NON_VISION_TOOL_IMAGE_PLACEHOLDER),
			};
		}

		return msg;
	});
}

/**
 * 规范化工具调用 ID，以兼容不同提供商。
 * OpenAI Responses API 生成的 ID 可能超过 450 个字符，并包含 `|` 等特殊字符。
 * Anthropic API 要求 ID 符合 ^[a-zA-Z0-9_-]+$，且最多 64 个字符。
 */
export function transformMessages<TApi extends Api>(
	messages: Message[],
	model: Model<TApi>,
	normalizeToolCallId?: (id: string, model: Model<TApi>, source: AssistantMessage) => string,
): Message[] {
	// 建立原始工具调用 ID 到规范化 ID 的映射。
	const toolCallIdMap = new Map<string, string>();
	// 将无类型调用方提供的 null/undefined 内容规范化（例如自定义工具、手动构造的历史记录或旧版会话文件），
	// 使后续代码可以依赖类型约定。
	const normalizedMessages = messages.map((msg) => (msg.content == null ? { ...msg, content: [] } : msg));
	const imageAwareMessages = downgradeUnsupportedImages(normalizedMessages, model);

	// 第一遍：转换消息（降级处理不支持的图像、思考块以及工具调用 ID 规范化）。
	const transformed = imageAwareMessages.map((msg) => {
		// 系统消息和用户消息保持原样传递。
		if (msg.role === "system" || msg.role === "user") {
			return msg;
		}

		// 处理 toolResult 消息：存在映射时规范化 toolCallId。
		if (msg.role === "toolResult") {
			const normalizedId = toolCallIdMap.get(msg.toolCallId);
			if (normalizedId && normalizedId !== msg.toolCallId) {
				return { ...msg, toolCallId: normalizedId };
			}
			return msg;
		}

		// 检查 assistant 消息是否需要转换。
		if (msg.role === "assistant") {
			const assistantMsg = msg as AssistantMessage;
			const isSameModel =
				assistantMsg.provider === model.provider &&
				assistantMsg.api === model.api &&
				assistantMsg.model === model.id;

			const transformedContent = assistantMsg.content.flatMap((block) => {
				if (block.type === "thinking") {
					// 隐去的思考内容是不可读取的加密数据，只能用于同一个模型。
					// 跨模型时将其丢弃，以免 API 报错。
					if (block.redacted) {
						return isSameModel ? block : [];
					}
					// 对于同一模型，即使思考文本为空（OpenAI 加密推理），也保留带签名的思考块，以便重放。
					if (isSameModel && block.thinkingSignature) return block;
					// 跳过空思考块，将其余思考块转换为纯文本。
					if (!block.thinking || block.thinking.trim() === "") return [];
					if (isSameModel) return block;
					return {
						type: "text" as const,
						text: block.thinking,
					};
				}

				if (block.type === "text") {
					if (isSameModel) return block;
					return {
						type: "text" as const,
						text: block.text,
					};
				}

				if (block.type === "toolCall") {
					const toolCall = block as ToolCall;
					let normalizedToolCall: ToolCall = toolCall;

					if (!isSameModel && toolCall.thoughtSignature) {
						normalizedToolCall = { ...toolCall };
						delete (normalizedToolCall as { thoughtSignature?: string }).thoughtSignature;
					}

					if (!isSameModel && normalizeToolCallId) {
						const normalizedId = normalizeToolCallId(toolCall.id, model, assistantMsg);
						if (normalizedId !== toolCall.id) {
							toolCallIdMap.set(toolCall.id, normalizedId);
							normalizedToolCall = { ...normalizedToolCall, id: normalizedId };
						}
					}

					return normalizedToolCall;
				}

				return block;
			});

			return {
				...assistantMsg,
				content: transformedContent,
			};
		}
		return msg;
	});

	// 第二遍：为孤立的工具调用插入合成的空工具结果。
	// 这样既能保留思考签名，也能满足 API 要求。
	const result: Message[] = [];
	let pendingToolCalls: ToolCall[] = [];
	let existingToolResultIds = new Set<string>();
	// 系统消息不参与工具调用的计数：如果系统消息出现在工具调用与其结果之间，就暂存起来，
	// 并在工具结果之后（包括合成结果）输出，避免之后收到真实结果时产生重复结果。
	const heldSystemMessages: Message[] = [];
	const closePendingToolCalls = () => {
		if (pendingToolCalls.length > 0) {
			for (const tc of pendingToolCalls) {
				if (!existingToolResultIds.has(tc.id)) {
					result.push({
						role: "toolResult",
						toolCallId: tc.id,
						toolName: tc.name,
						content: [{ type: "text", text: "No result provided" }],
						isError: true,
						timestamp: Date.now(),
					} as ToolResultMessage);
				}
			}
			pendingToolCalls = [];
			existingToolResultIds = new Set();
		}
		result.push(...heldSystemMessages);
		heldSystemMessages.length = 0;
	};

	for (let i = 0; i < transformed.length; i++) {
		const msg = transformed[i];

		if (msg.role === "assistant") {
			// 如果前一条 assistant 消息遗留了未完成的工具调用，现在插入合成结果。
			closePendingToolCalls();

			// 完全跳过出错或中止的 assistant 消息。
			// 这些回合不完整，不应重放：
			// - 可能包含不完整内容（例如只有推理内容而没有消息，或工具调用未完成）。
			// - 重放这类消息可能导致 API 错误（例如 OpenAI 的 "reasoning without following item"）。
			// - 模型应从最近的有效状态重新尝试。
			const assistantMsg = msg as AssistantMessage;
			if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
				continue;
			}

			// 记录这条 assistant 消息中的工具调用。
			const toolCalls = assistantMsg.content.filter((b) => b.type === "toolCall") as ToolCall[];
			if (toolCalls.length > 0) {
				pendingToolCalls = toolCalls;
				existingToolResultIds = new Set();
			}

			result.push(msg);
		} else if (msg.role === "toolResult") {
			existingToolResultIds.add(msg.toolCallId);
			result.push(msg);
		} else if (msg.role === "system") {
			if (pendingToolCalls.length > 0) {
				heldSystemMessages.push(msg);
			} else {
				result.push(msg);
			}
		} else if (msg.role === "user") {
			// 新的用户回合会中断工具调用流程，因此为遗留的未完成调用插入合成结果。
			closePendingToolCalls();
			result.push(msg);
		} else {
			result.push(msg);
		}
	}

	// 如果对话以尚未解决的工具调用结束，现在为其生成合成结果。
	closePendingToolCalls();

	return result;
}
