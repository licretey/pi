import type OpenAI from "openai";
import type {
	Tool as OpenAITool,
	ResponseCreateParamsStreaming,
	ResponseInput,
	ResponseInputContent,
	ResponseInputImage,
	ResponseInputItem,
	ResponseInputText,
	ResponseOutputItem,
	ResponseOutputMessage,
	ResponseReasoningItem,
	ResponseStreamEvent,
	ResponseToolSearchOutputItemParam,
} from "openai/resources/responses/responses.js";
import { calculateCost } from "../models.ts";
import type {
	Api,
	AssistantMessage,
	ImageContent,
	Model,
	StopReason,
	StreamOptions,
	SystemMessage,
	TextContent,
	TextSignatureV1,
	ThinkingContent,
	Tool,
	ToolCall,
	TranscriptContext,
	Usage,
} from "../types.ts";
import type { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { shortHash } from "../utils/hash.ts";
import { parseStreamingJson } from "../utils/json-parse.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { getSystemMessageText, renderSystemMessageUpdate } from "../utils/text.ts";
import { resolveTranscript, resolveTranscriptTools } from "../utils/transcript.ts";
import {
	appendGrammarToolInputJsonDelta,
	type GrammarToolInputJsonBuffer,
	getGrammarToolInput,
	getJsonSchemaToolParameters,
	resolveGrammarConstrainedSampling,
	resolveJsonSchemaStrictSampling,
} from "./constrained-sampling.ts";
import { transformMessages } from "./transform-messages.ts";

// =============================================================================
// 工具函数。
// =============================================================================

function encodeTextSignatureV1(id: string, phase?: TextSignatureV1["phase"]): string {
	const payload: TextSignatureV1 = { v: 1, id };
	if (phase) payload.phase = phase;
	return JSON.stringify(payload);
}

function parseTextSignature(
	signature: string | undefined,
): { id: string; phase?: TextSignatureV1["phase"] } | undefined {
	if (!signature) return undefined;
	if (signature.startsWith("{")) {
		try {
			const parsed = JSON.parse(signature) as Partial<TextSignatureV1>;
			if (parsed.v === 1 && typeof parsed.id === "string") {
				if (parsed.phase === "commentary" || parsed.phase === "final_answer") {
					return { id: parsed.id, phase: parsed.phase };
				}
				return { id: parsed.id };
			}
		} catch {
			// 继续执行旧版纯字符串处理逻辑。
		}
	}
	return { id: signature };
}

type ToolResultOutputContent = Array<ResponseInputText | ResponseInputImage>;

function convertToolResultOutput<TApi extends Api>(
	model: Model<TApi>,
	content: readonly (TextContent | ImageContent)[],
): string | ToolResultOutputContent {
	const textResult = content
		.filter((c): c is TextContent => c.type === "text")
		.map((c) => c.text)
		.join("\n");
	const images = content.filter((c): c is ImageContent => c.type === "image");
	const hasText = textResult.length > 0;

	if (images.length === 0 || !model.input.includes("image")) {
		return sanitizeSurrogates(hasText ? textResult : images.length > 0 ? "(see attached image)" : "(no tool output)");
	}

	const output: ToolResultOutputContent = [];
	if (hasText) {
		output.push({ type: "input_text", text: sanitizeSurrogates(textResult) });
	}
	for (const image of images) {
		output.push({
			type: "input_image",
			detail: "auto",
			image_url: `data:${image.mimeType};base64,${image.data}`,
		});
	}
	return output;
}

export interface OpenAIResponsesStreamOptions {
	onProviderStreamEvent?: StreamOptions["onProviderStreamEvent"];
	serviceTier?: ResponseCreateParamsStreaming["service_tier"];
	grammarToolInputProperties?: ReadonlyMap<string, string>;
	resolveServiceTier?: (
		responseServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
		requestServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	) => ResponseCreateParamsStreaming["service_tier"] | undefined;
	applyServiceTierPricing?: (
		usage: Usage,
		serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	) => void;
}

export interface ConvertResponsesMessagesOptions {
	includeSystemPrompt?: boolean;
	grammarToolInputProperties?: ReadonlyMap<string, string>;
	/** 后续 system 消息是否原样发送；否则会合并到开头的提示中。 */
	supportsMidConvoSystemMessages?: boolean;
	supportsAdditionalTools?: boolean;
	supportsToolSearch?: boolean;
	toolOptions?: ConvertResponsesToolsOptions;
}

export interface ConvertResponsesToolsOptions {
	strict?: boolean | null;
	supportsStrictMode?: boolean;
	supportsOpenAIGrammarTools?: boolean;
	toolSearchResult?: boolean;
}

// =============================================================================
// 转换消息
// =============================================================================

export function convertResponsesMessages<TApi extends Api>(
	model: Model<TApi>,
	context: TranscriptContext,
	allowedToolCallProviders: ReadonlySet<string>,
	options?: ConvertResponsesMessagesOptions,
): ResponseInput {
	const normalizedContext = resolveTranscript(context, options?.supportsMidConvoSystemMessages);
	const messages: ResponseInput = [];

	const normalizeIdPart = (part: string): string => {
		const sanitized = part.replace(/[^a-zA-Z0-9_-]/g, "_");
		const normalized = sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
		return normalized.replace(/_+$/, "");
	};

	const buildForeignResponsesItemId = (itemId: string): string => {
		const normalized = `fc_${shortHash(itemId)}`;
		return normalized.length > 64 ? normalized.slice(0, 64) : normalized;
	};

	const normalizeToolCallId = (id: string, _targetModel: Model<TApi>, source: AssistantMessage): string => {
		if (!allowedToolCallProviders.has(model.provider)) return normalizeIdPart(id);
		if (!id.includes("|")) return normalizeIdPart(id);
		const [callId, itemId] = id.split("|");
		const normalizedCallId = normalizeIdPart(callId);
		const isForeignToolCall = source.provider !== model.provider || source.api !== model.api;
		let normalizedItemId = isForeignToolCall ? buildForeignResponsesItemId(itemId) : normalizeIdPart(itemId);
		// OpenAI Responses API 要求条目 ID 以 "fc" 开头。
		if (!normalizedItemId.startsWith("fc_")) {
			normalizedItemId = normalizeIdPart(`fc_${normalizedItemId}`);
		}
		return `${normalizedCallId}|${normalizedItemId}`;
	};

	const transformedMessages = transformMessages(normalizedContext.messages, model, normalizeToolCallId);
	const transcriptTools = resolveTranscriptTools(
		normalizedContext.messages,
		(options?.supportsAdditionalTools ?? false) || (options?.supportsToolSearch ?? false),
	);
	const appendSystemToolAdditions = (message: SystemMessage, seed: string): void => {
		const tools = transcriptTools.anchorsAdditions ? (message.toolsAdded ?? []) : [];
		if (tools.length === 0) return;
		if (options?.supportsAdditionalTools) {
			messages.push({
				type: "additional_tools",
				role: "developer",
				tools: convertResponsesTools(tools, options.toolOptions),
			} satisfies ResponseInputItem);
			return;
		}
		if (!options?.supportsToolSearch) return;
		const names = tools.map((tool) => tool.name);
		const callId = `pi_tool_load_${shortHash(`${seed}:${names.join(",")}`)}`;
		messages.push({
			type: "tool_search_call",
			call_id: callId,
			execution: "client",
			status: "completed",
			arguments: { query: names.join(" "), limit: names.length },
		} satisfies ResponseInputItem);
		messages.push({
			type: "tool_search_output",
			call_id: callId,
			execution: "client",
			status: "completed",
			tools: convertResponsesTools(tools, { ...options.toolOptions, toolSearchResult: true }),
		} satisfies ResponseToolSearchOutputItemParam);
	};
	const includeInitialSystemMessage = options?.includeSystemPrompt ?? true;
	const compat = model.compat as { supportsDeveloperRole?: boolean } | undefined;
	const instructionRole = model.reasoning && compat?.supportsDeveloperRole !== false ? "developer" : "system";

	let msgIndex = 0;
	let sourceIndex = 0;
	for (const msg of transformedMessages) {
		const isLeadingSystemMessage = sourceIndex++ === 0 && msg.role === "system";
		if (msg.role === "system") {
			if (!isLeadingSystemMessage) appendSystemToolAdditions(msg, `system:${msgIndex}`);
			if (!isLeadingSystemMessage || includeInitialSystemMessage) {
				const text = isLeadingSystemMessage ? getSystemMessageText(msg) : renderSystemMessageUpdate(msg);
				if (text.length > 0) {
					messages.push({ role: instructionRole, content: sanitizeSurrogates(text) });
				}
			}
		} else if (msg.role === "user") {
			if (typeof msg.content === "string") {
				messages.push({
					role: "user",
					content: [{ type: "input_text", text: sanitizeSurrogates(msg.content) }],
				});
			} else {
				const content: ResponseInputContent[] = msg.content.map((item): ResponseInputContent => {
					if (item.type === "text") {
						return {
							type: "input_text",
							text: sanitizeSurrogates(item.text),
						} satisfies ResponseInputText;
					}
					return {
						type: "input_image",
						detail: "auto",
						image_url: `data:${item.mimeType};base64,${item.data}`,
					} satisfies ResponseInputImage;
				});
				if (content.length === 0) continue;
				messages.push({
					role: "user",
					content,
				});
			}
		} else if (msg.role === "assistant") {
			const output: ResponseInput = [];
			const assistantMsg = msg as AssistantMessage;
			const isSameProviderAndApi = assistantMsg.provider === model.provider && assistantMsg.api === model.api;
			const isSameModel = isSameProviderAndApi && assistantMsg.model === model.id;
			const isDifferentModel = isSameProviderAndApi && assistantMsg.model !== model.id;
			let textBlockIndex = 0;

			for (const block of msg.content) {
				if (block.type === "thinking") {
					if (block.thinkingSignature) {
						const reasoningItem = JSON.parse(block.thinkingSignature) as ResponseReasoningItem;
						output.push(reasoningItem);
					}
				} else if (block.type === "text") {
					const textBlock = block as TextContent;
					const parsedSignature = parseTextSignature(textBlock.textSignature);
					const fallbackMessageId =
						textBlockIndex === 0 ? `msg_pi_${msgIndex}` : `msg_pi_${msgIndex}_${textBlockIndex}`;
					textBlockIndex++;
					// OpenAI 要求 ID 最多 64 个字符。
					let msgId = parsedSignature?.id;
					if (!msgId) {
						msgId = fallbackMessageId;
					} else if (msgId.length > 64) {
						msgId = `msg_${shortHash(msgId)}`;
					}
					output.push({
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: sanitizeSurrogates(textBlock.text), annotations: [] }],
						status: "completed",
						id: msgId,
						phase: parsedSignature?.phase,
					} satisfies ResponseOutputMessage);
				} else if (block.type === "toolCall") {
					const toolCall = block as ToolCall;
					const [callId, itemIdRaw] = toolCall.id.split("|");
					const customInputProperty = options?.grammarToolInputProperties?.get(toolCall.name);
					let itemId: string | undefined = itemIdRaw;

					// 对于来自不同模型的消息，将 id 设为 undefined，以避免触发配对校验。
					// OpenAI 会跟踪哪些条目 ID 与 rs_xxx 推理条目配对。
					// 省略 id 可避免触发该校验（与跨提供商处理方式相同）。
					// 同时移除与重放条目类型不匹配的 ID：function_call 的 ID 必须以 fc_ 开头，
					// custom_tool_call 的 ID 必须以 ctc_ 开头。外部工具调用 ID 会规范化为 fc_，
					// 并且当语法工具支持不同时，同一调用可能在这两种类型之间切换。
					const itemIdPrefix = customInputProperty === undefined ? "fc_" : "ctc_";
					if (isDifferentModel || !itemId?.startsWith(itemIdPrefix)) {
						itemId = undefined;
					}

					if (customInputProperty !== undefined) {
						output.push({
							type: "custom_tool_call",
							id: itemId,
							call_id: callId,
							name: toolCall.name,
							input: sanitizeSurrogates(
								getGrammarToolInput(toolCall.name, toolCall.arguments, customInputProperty),
							),
							...(isSameModel && toolCall.namespace !== undefined ? { namespace: toolCall.namespace } : {}),
						} satisfies ResponseOutputItem);
					} else {
						output.push({
							type: "function_call",
							id: itemId,
							call_id: callId,
							name: toolCall.name,
							arguments: JSON.stringify(toolCall.arguments),
							...(isSameModel && toolCall.namespace !== undefined ? { namespace: toolCall.namespace } : {}),
						});
					}
				}
			}
			if (output.length === 0) continue;
			messages.push(...output);
		} else if (msg.role === "toolResult") {
			const [callId] = msg.toolCallId.split("|");
			const output = convertToolResultOutput(model, msg.content);

			if (options?.grammarToolInputProperties?.has(msg.toolName)) {
				messages.push({
					type: "custom_tool_call_output",
					call_id: callId,
					output,
				});
			} else {
				messages.push({
					type: "function_call_output",
					call_id: callId,
					output,
				});
			}
		}
		if (!isLeadingSystemMessage) msgIndex++;
	}

	return messages;
}

// =============================================================================
// 工具转换。
// =============================================================================

export function convertResponsesTools(tools: readonly Tool[], options?: ConvertResponsesToolsOptions): OpenAITool[] {
	const defaultStrict = options?.strict === undefined ? false : options.strict;
	const supportsStrictMode = options?.supportsStrictMode ?? true;
	const supportsOpenAIGrammarTools = options?.supportsOpenAIGrammarTools ?? false;

	return tools.map((tool) => {
		const grammar = resolveGrammarConstrainedSampling(tool, supportsOpenAIGrammarTools);
		if (grammar) {
			return {
				type: "custom",
				name: tool.name,
				description: tool.description,
				format: {
					type: "grammar",
					syntax: grammar.format,
					definition: grammar.definition,
				},
				...(options?.toolSearchResult ? { defer_loading: true } : {}),
			} satisfies OpenAITool;
		}

		const constrainedStrict = resolveJsonSchemaStrictSampling(tool, supportsStrictMode);
		const strict = constrainedStrict ?? defaultStrict;
		const functionTool: Omit<Extract<OpenAITool, { type: "function" }>, "strict"> & {
			strict?: Extract<OpenAITool, { type: "function" }>["strict"];
		} = {
			type: "function",
			name: tool.name,
			description: tool.description,
			parameters: getJsonSchemaToolParameters(tool, strict === true) as Record<string, unknown>,
			...(options?.toolSearchResult ? { defer_loading: true } : {}),
		};
		if (supportsStrictMode) {
			functionTool.strict = strict;
		}
		return functionTool as OpenAITool;
	});
}

// =============================================================================
// 处理数据流
// =============================================================================

type StreamingToolCall = ToolCall & {
	partialJson?: string;
	customInput?: {
		property: string;
		jsonBuffer: GrammarToolInputJsonBuffer;
	};
};

function getCustomToolCallInput(block: StreamingToolCall): string {
	const property = block.customInput?.property;
	if (property === undefined) return "";
	const value = block.arguments[property];
	return typeof value === "string" ? value : "";
}

function appendCustomToolCallInput(block: StreamingToolCall, nextInput: string, close: boolean): string | undefined {
	const customInput = block.customInput;
	if (!customInput) return undefined;
	const delta = appendGrammarToolInputJsonDelta(customInput.jsonBuffer, customInput.property, nextInput, close);
	block.arguments = { [customInput.property]: nextInput };
	return delta;
}

type ResponsesOutputSlot =
	| { type: "thinking"; block: ThinkingContent; contentIndex: number }
	| { type: "text"; block: TextContent; contentIndex: number }
	| { type: "toolCall"; block: StreamingToolCall; contentIndex: number };

type ToolCallOutputSlot = Extract<ResponsesOutputSlot, { type: "toolCall" }>;

export async function processResponsesStream<TApi extends Api>(
	openaiStream: AsyncIterable<ResponseStreamEvent>,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<TApi>,
	options?: OpenAIResponsesStreamOptions,
): Promise<void> {
	let sawTerminalResponseEvent = false;
	const outputSlots = new Map<number, ResponsesOutputSlot>();
	const reasoningBlocksById = new Map<string, ThinkingContent>();
	const applyMessagePhaseStopReason = (item: ResponseOutputItem): void => {
		if (item.type === "message" && item.phase === "final_answer") {
			output.stopReason = "stop";
		}
	};
	const getSlot = <TType extends ResponsesOutputSlot["type"]>(
		outputIndex: number,
		type: TType,
	): Extract<ResponsesOutputSlot, { type: TType }> | undefined => {
		const slot = outputSlots.get(outputIndex);
		return slot?.type === type ? (slot as Extract<ResponsesOutputSlot, { type: TType }>) : undefined;
	};
	const pushToolCallDelta = (slot: ToolCallOutputSlot, delta: string | undefined): void => {
		if (delta === undefined) return;
		stream.push({
			type: "toolcall_delta",
			contentIndex: slot.contentIndex,
			delta,
			partial: output,
		});
	};
	const createSlot = (outputIndex: number, item: ResponseOutputItem): ResponsesOutputSlot | undefined => {
		if (item.type === "reasoning") {
			const block: ThinkingContent = { type: "thinking", thinking: "" };
			output.content.push(block);
			const slot = {
				type: "thinking",
				block,
				contentIndex: output.content.length - 1,
			} satisfies ResponsesOutputSlot;
			outputSlots.set(outputIndex, slot);
			stream.push({ type: "thinking_start", contentIndex: slot.contentIndex, partial: output });
			return slot;
		}
		if (item.type === "message") {
			applyMessagePhaseStopReason(item);
			const block: TextContent = { type: "text", text: "" };
			output.content.push(block);
			const slot = { type: "text", block, contentIndex: output.content.length - 1 } satisfies ResponsesOutputSlot;
			outputSlots.set(outputIndex, slot);
			stream.push({ type: "text_start", contentIndex: slot.contentIndex, partial: output });
			return slot;
		}
		if (item.type === "function_call") {
			const block: StreamingToolCall = {
				type: "toolCall",
				id: `${item.call_id}|${item.id}`,
				name: item.name,
				arguments: {},
				...(item.namespace !== undefined ? { namespace: item.namespace } : {}),
				partialJson: item.arguments || "",
			};
			output.content.push(block);
			const slot = {
				type: "toolCall",
				block,
				contentIndex: output.content.length - 1,
			} satisfies ResponsesOutputSlot;
			outputSlots.set(outputIndex, slot);
			stream.push({ type: "toolcall_start", contentIndex: slot.contentIndex, partial: output });
			return slot;
		}
		if (item.type === "custom_tool_call") {
			const inputProperty = options?.grammarToolInputProperties?.get(item.name) ?? "input";
			const input = item.input || "";
			const block: StreamingToolCall = {
				type: "toolCall",
				id: `${item.call_id}|${item.id}`,
				name: item.name,
				arguments: { [inputProperty]: input },
				...(item.namespace !== undefined ? { namespace: item.namespace } : {}),
				customInput: {
					property: inputProperty,
					jsonBuffer: { input: "", started: false, closed: false },
				},
			};
			output.content.push(block);
			const slot = {
				type: "toolCall",
				block,
				contentIndex: output.content.length - 1,
			} satisfies ResponsesOutputSlot;
			outputSlots.set(outputIndex, slot);
			stream.push({ type: "toolcall_start", contentIndex: slot.contentIndex, partial: output });
			return slot;
		}
		return undefined;
	};
	const getOrCreateSlot = (outputIndex: number, item: ResponseOutputItem): ResponsesOutputSlot | undefined => {
		return outputSlots.get(outputIndex) ?? createSlot(outputIndex, item);
	};
	// Azure OpenAI 可能会在 response.output_item.done 中省略 reasoning.encrypted_content，
	// 而只在 response.completed.response.output 中提供。此处从最终响应补回持久化的推理签名，
	// 使 store:false 的多轮重放保持无状态。参见 https://github.com/earendil-works/pi/issues/6409。
	const backfillReasoningSignatures = (responseOutput: ResponseOutputItem[]): void => {
		for (const item of responseOutput) {
			if (item.type !== "reasoning" || !item.encrypted_content) continue;
			const block = reasoningBlocksById.get(item.id);
			if (!block?.thinkingSignature) continue;

			const storedItem = JSON.parse(block.thinkingSignature) as ResponseReasoningItem;
			if (storedItem.encrypted_content) continue;
			block.thinkingSignature = JSON.stringify({
				...storedItem,
				encrypted_content: item.encrypted_content,
			});
		}
	};
	const finalizeResponse = (
		response: Extract<ResponseStreamEvent, { type: "response.completed" | "response.incomplete" }>["response"],
	): void => {
		sawTerminalResponseEvent = true;
		backfillReasoningSignatures(response.output ?? []);
		if (response?.id) {
			output.responseId = response.id;
		}
		if (response?.usage) {
			const inputDetails = response.usage.input_tokens_details as
				| { cached_tokens?: number; cache_write_tokens?: number }
				| undefined;
			const cachedTokens = inputDetails?.cached_tokens || 0;
			const cacheWriteTokens = inputDetails?.cache_write_tokens || 0;
			output.usage = {
				// OpenAI 会将缓存读取和缓存写入 token 都计入 input_tokens，因此需要同时减去两者。
				input: Math.max(0, (response.usage.input_tokens || 0) - cachedTokens - cacheWriteTokens),
				output: response.usage.output_tokens || 0,
				cacheRead: cachedTokens,
				cacheWrite: cacheWriteTokens,
				reasoning: response.usage.output_tokens_details?.reasoning_tokens || 0,
				totalTokens: response.usage.total_tokens || 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
		}
		calculateCost(model, output.usage);
		if (options?.applyServiceTierPricing) {
			const serviceTier = options.resolveServiceTier
				? options.resolveServiceTier(response?.service_tier, options.serviceTier)
				: (response?.service_tier ?? options.serviceTier);
			options.applyServiceTierPricing(output.usage, serviceTier);
		}
		// 将状态映射为停止原因。对于未完成的响应，保留提供商返回的具体原因，以区分最大输出截断和内容过滤。
		const status = response?.status;
		const incompleteDetails = response?.incomplete_details as { reason?: unknown } | null | undefined;
		const incompleteReason = typeof incompleteDetails?.reason === "string" ? incompleteDetails.reason : undefined;
		output.rawStopReason = incompleteReason ? `${status}.${incompleteReason}` : status;
		const mappedStop = mapStopReason(status, incompleteReason);
		output.stopReason = mappedStop.stopReason;
		if (mappedStop.errorMessage === undefined) delete output.errorMessage;
		else output.errorMessage = mappedStop.errorMessage;
		if (output.content.some((b) => b.type === "toolCall") && output.stopReason === "stop") {
			output.stopReason = "toolUse";
		}
	};

	for await (const event of openaiStream) {
		await options?.onProviderStreamEvent?.(event, model);
		if (event.type === "response.created") {
			output.responseId = event.response.id;
		} else if (event.type === "response.output_item.added") {
			createSlot(event.output_index, event.item);
		} else if (event.type === "response.reasoning_summary_text.delta") {
			const slot = getSlot(event.output_index, "thinking");
			if (!slot) continue;
			slot.block.thinking += event.delta;
			stream.push({
				type: "thinking_delta",
				contentIndex: slot.contentIndex,
				delta: event.delta,
				partial: output,
			});
		} else if (event.type === "response.reasoning_summary_part.done") {
			const slot = getSlot(event.output_index, "thinking");
			if (!slot) continue;
			slot.block.thinking += "\n\n";
			stream.push({
				type: "thinking_delta",
				contentIndex: slot.contentIndex,
				delta: "\n\n",
				partial: output,
			});
		} else if (event.type === "response.reasoning_text.delta") {
			const slot = getSlot(event.output_index, "thinking");
			if (!slot) continue;
			slot.block.thinking += event.delta;
			stream.push({
				type: "thinking_delta",
				contentIndex: slot.contentIndex,
				delta: event.delta,
				partial: output,
			});
		} else if (event.type === "response.output_text.delta") {
			const slot = getSlot(event.output_index, "text");
			if (!slot) continue;
			slot.block.text += event.delta;
			stream.push({
				type: "text_delta",
				contentIndex: slot.contentIndex,
				delta: event.delta,
				partial: output,
			});
		} else if (event.type === "response.refusal.delta") {
			const slot = getSlot(event.output_index, "text");
			if (!slot) continue;
			slot.block.text += event.delta;
			stream.push({
				type: "text_delta",
				contentIndex: slot.contentIndex,
				delta: event.delta,
				partial: output,
			});
		} else if (event.type === "response.function_call_arguments.delta") {
			const slot = getSlot(event.output_index, "toolCall");
			if (!slot || slot.block.partialJson === undefined) continue;
			slot.block.partialJson += event.delta;
			slot.block.arguments = parseStreamingJson(slot.block.partialJson);
			pushToolCallDelta(slot, event.delta);
		} else if (event.type === "response.function_call_arguments.done") {
			const slot = getSlot(event.output_index, "toolCall");
			if (!slot || slot.block.partialJson === undefined) continue;
			const previousPartialJson = slot.block.partialJson;
			slot.block.partialJson = event.arguments;
			slot.block.arguments = parseStreamingJson(slot.block.partialJson);

			if (event.arguments.startsWith(previousPartialJson)) {
				const delta = event.arguments.slice(previousPartialJson.length);
				if (delta.length > 0) pushToolCallDelta(slot, delta);
			}
		} else if (event.type === "response.custom_tool_call_input.delta") {
			const slot = getSlot(event.output_index, "toolCall");
			if (!slot || !slot.block.customInput) continue;
			pushToolCallDelta(
				slot,
				appendCustomToolCallInput(slot.block, getCustomToolCallInput(slot.block) + event.delta, false),
			);
		} else if (event.type === "response.custom_tool_call_input.done") {
			const slot = getSlot(event.output_index, "toolCall");
			if (!slot || !slot.block.customInput) continue;
			pushToolCallDelta(slot, appendCustomToolCallInput(slot.block, event.input, true));
		} else if (event.type === "response.output_item.done") {
			const item = event.item;
			applyMessagePhaseStopReason(item);
			const slot = getOrCreateSlot(event.output_index, item);

			if (item.type === "reasoning" && slot?.type === "thinking") {
				const summaryText = item.summary?.map((s) => s.text).join("\n\n") || "";
				const contentText = item.content?.map((c) => c.text).join("\n\n") || "";
				slot.block.thinking = summaryText || contentText || slot.block.thinking;
				slot.block.thinkingSignature = JSON.stringify(item);
				reasoningBlocksById.set(item.id, slot.block);
				stream.push({
					type: "thinking_end",
					contentIndex: slot.contentIndex,
					content: slot.block.thinking,
					partial: output,
				});
				outputSlots.delete(event.output_index);
			} else if (item.type === "message" && slot?.type === "text") {
				slot.block.text = item.content?.map((c) => (c.type === "output_text" ? c.text : c.refusal)).join("") || "";
				slot.block.textSignature = encodeTextSignatureV1(item.id, item.phase ?? undefined);
				stream.push({
					type: "text_end",
					contentIndex: slot.contentIndex,
					content: slot.block.text,
					partial: output,
				});
				outputSlots.delete(event.output_index);
			} else if (
				item.type === "function_call" &&
				slot?.type === "toolCall" &&
				slot.block.partialJson !== undefined
			) {
				slot.block.arguments = parseStreamingJson(item.arguments || slot.block.partialJson || "{}");
				if (item.namespace !== undefined) slot.block.namespace = item.namespace;
				// 原地完成解析并清除临时缓冲区，使重放数据只包含已解析的参数。
				delete slot.block.partialJson;
				stream.push({
					type: "toolcall_end",
					contentIndex: slot.contentIndex,
					toolCall: slot.block,
					partial: output,
				});
				outputSlots.delete(event.output_index);
			} else if (item.type === "custom_tool_call" && slot?.type === "toolCall" && slot.block.customInput) {
				pushToolCallDelta(
					slot,
					appendCustomToolCallInput(slot.block, item.input ?? getCustomToolCallInput(slot.block), true),
				);
				if (item.namespace !== undefined) slot.block.namespace = item.namespace;
				delete slot.block.customInput;
				stream.push({
					type: "toolcall_end",
					contentIndex: slot.contentIndex,
					toolCall: slot.block,
					partial: output,
				});
				outputSlots.delete(event.output_index);
			}
		} else if (event.type === "response.completed" || event.type === "response.incomplete") {
			finalizeResponse(event.response);
		} else if (event.type === "error") {
			throw new Error(`Error Code ${event.code}: ${event.message}` || "Unknown error");
		} else if (event.type === "response.failed") {
			sawTerminalResponseEvent = true;
			output.rawStopReason = event.response?.status;
			const error = event.response?.error;
			const details = event.response?.incomplete_details;
			const msg = error
				? `${error.code || "unknown"}: ${error.message || "no message"}`
				: details?.reason
					? `incomplete: ${details.reason}`
					: "Unknown error (no error details in response)";
			throw new Error(msg);
		}
	}
	if (!sawTerminalResponseEvent) {
		throw new Error("OpenAI Responses stream ended before a terminal response event");
	}
	// 智能体会执行最终消息中的所有工具调用。若未收到 output_item.done，则拒绝提交该调用，
	// 因为参数可能被截断或混淆，例如不符合规范的服务器省略了 output_index。已完成调用的临时缓冲区会被清除。
	if (output.stopReason === "toolUse") {
		for (const block of output.content) {
			if (block.type !== "toolCall") continue;
			const toolCall = block as StreamingToolCall;
			if (toolCall.partialJson !== undefined || toolCall.customInput !== undefined) {
				throw new Error(
					`OpenAI Responses stream completed with an unfinished tool call: ${toolCall.name} (${toolCall.id})`,
				);
			}
		}
	}
}

function mapStopReason(
	status: OpenAI.Responses.ResponseStatus | undefined,
	incompleteReason?: string,
): { stopReason: StopReason; errorMessage?: string } {
	if (!status) return { stopReason: "stop" };
	switch (status) {
		case "completed":
			return { stopReason: "stop" };
		case "incomplete":
			if (incompleteReason === "max_output_tokens") {
				return { stopReason: "length" };
			}
			return {
				stopReason: "error",
				errorMessage: incompleteReason
					? `Response incomplete: ${incompleteReason}`
					: "Response incomplete without a provider reason",
			};
		case "failed":
		case "cancelled":
			return { stopReason: "error" };
		// 这两种情况比较特殊……
		case "in_progress":
		case "queued":
			return { stopReason: "stop" };
		default: {
			const _exhaustive: never = status;
			throw new Error(`Unhandled stop reason: ${_exhaustive}`);
		}
	}
}
