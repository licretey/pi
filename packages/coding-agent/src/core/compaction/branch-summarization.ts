/**
 * 用于 session tree 导航的 branch 摘要。
 *
 * 当导航到 session tree 中的另一个位置时，会为被离开的 branch 生成
 * 一份摘要，避免上下文丢失。
 */

import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import type { RetryCallbacks, RetryPolicy } from "@earendil-works/pi-ai";
import { contentText, normalizeContext } from "@earendil-works/pi-ai";
import type { Model, SimpleStreamOptions, Usage } from "@earendil-works/pi-ai/compat";
import {
	convertToLlm,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "../messages.ts";
import type { ReadonlySessionManager, SessionEntry } from "../session-manager.ts";
import { completeSummarization, estimateTokens, getSummarizationFailure } from "./compaction.ts";
import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	type FileOperations,
	formatFileOperations,
	SUMMARIZATION_SYSTEM_PROMPT,
	serializeConversation,
} from "./utils.ts";

// ============================================================================
// 类型
// ============================================================================

export interface BranchSummaryResult {
	summary?: string;
	usage?: Usage;
	readFiles?: string[];
	modifiedFiles?: string[];
	aborted?: boolean;
	error?: string;
}

/** 存于 BranchSummaryEntry.details 中用于文件追踪的明细 */
export interface BranchSummaryDetails {
	readFiles: string[];
	modifiedFiles: string[];
}

export type { FileOperations } from "./utils.ts";

export interface BranchPreparation {
	/** 按时间顺序提取出的、用于摘要的消息 */
	messages: AgentMessage[];
	/** 从 tool call 中提取出的文件操作 */
	fileOps: FileOperations;
	/** 消息的估算 token 总数 */
	totalTokens: number;
}

export interface CollectEntriesResult {
	/** 按时间顺序排列的待摘要 entry */
	entries: SessionEntry[];
	/** 旧位置与新位置之间的共同祖先（若存在） */
	commonAncestorId: string | null;
}

export interface GenerateBranchSummaryOptions {
	/** 用于摘要的模型 */
	model: Model<any>;
	/** 模型的 API key */
	apiKey?: string;
	/** 模型的请求头 */
	headers?: Record<string, string>;
	/** 模型按提供商作用域的环境变量值 */
	env?: Record<string, string>;
	/** 用于取消的 abort signal */
	signal: AbortSignal;
	/** 可选的摘要自定义指令 */
	customInstructions?: string;
	/** 为 true 时，customInstructions 替换默认 prompt 而不是追加 */
	replaceInstructions?: boolean;
	/** 选择 branch 历史时预留的 token 数（默认 16384） */
	reserveTokens?: number;
	/** 可选的 session 流函数。用于保持 SDK 请求行为一致，而不改动 agent 状态。 */
	streamFn?: StreamFn;
	/** 针对瞬时摘要错误的重试策略。复用 coding-agent 的 `settings.retry`。 */
	retry?: RetryPolicy;
	/** 可选的重试上报回调（例如 TUI 的重试指示器）。 */
	callbacks?: RetryCallbacks;
}

// ============================================================================
// entry 收集
// ============================================================================

/**
 * 收集从一个位置导航到另一位置时需要摘要的 entry。
 *
 * 从 oldLeafId 向回走到与 targetId 的共同祖先，沿途收集 entry。
 * 不会在 compaction 边界停下——它们被包含在内，其摘要会成为上下文。
 *
 * @param session - Session manager（只读访问）
 * @param oldLeafId - 当前位置（从这里导航离开）
 * @param targetId - 目标位置（导航到这里）
 * @returns 待摘要的 entry 与共同祖先
 */
export function collectEntriesForBranchSummary(
	session: ReadonlySessionManager,
	oldLeafId: string | null,
	targetId: string,
): CollectEntriesResult {
	// 没有旧位置时，无需摘要
	if (!oldLeafId) {
		return { entries: [], commonAncestorId: null };
	}

	// 寻找共同祖先（同时位于两条路径上的最深节点）
	const oldPath = new Set(session.getBranch(oldLeafId).map((e) => e.id));
	const targetPath = session.getBranch(targetId);

	// targetPath 是根在前的，因此反向迭代以找到最深的共同祖先
	let commonAncestorId: string | null = null;
	for (let i = targetPath.length - 1; i >= 0; i--) {
		if (oldPath.has(targetPath[i].id)) {
			commonAncestorId = targetPath[i].id;
			break;
		}
	}

	// 从旧叶子向回收集 entry，直到共同祖先
	const entries: SessionEntry[] = [];
	let current: string | null = oldLeafId;

	while (current && current !== commonAncestorId) {
		const entry = session.getEntry(current);
		if (!entry) break;
		entries.push(entry);
		current = entry.parentId;
	}

	// 反转以获得时间顺序
	entries.reverse();

	return { entries, commonAncestorId };
}

// ============================================================================
// entry 到消息的转换
// ============================================================================

/**
 * 从 session entry 中提取 AgentMessage。
 * 与 compaction.ts 中 getMessageFromEntry 类似，但还处理 compaction entry。
 */
function getMessageFromEntry(entry: SessionEntry): AgentMessage | undefined {
	switch (entry.type) {
		case "message":
			// 跳过工具结果——上下文位于 assistant 的 tool call 中
			if (entry.message.role === "toolResult") return undefined;
			return entry.message;

		case "custom_message":
			return createCustomMessage(entry.customType, entry.content, entry.display, entry.details, entry.timestamp);

		case "branch_summary":
			return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);

		case "compaction":
			return createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp);

		// 这些不参与对话内容
		case "thinking_level_change":
		case "model_change":
		case "custom":
		case "label":
		case "session_info":
			return undefined;
	}
}

/**
 * 在 token 预算内准备待摘要的 entry。
 *
 * 从最新到最旧遍历 entry，不断加入消息直到触及 token 预算。
 * 这保证 branch 过长时保留的是最近的上下文。
 *
 * 同时从以下来源收集文件操作：
 * - assistant 消息中的 tool call
 * - 已有 branch_summary entry 的 details（用于累计追踪）
 *
 * @param entries - 按时间顺序排列的 entry
 * @param tokenBudget - 可包含的最大 token 数（0 = 无限制）
 */
export function prepareBranchEntries(entries: SessionEntry[], tokenBudget: number = 0): BranchPreparation {
	const messages: AgentMessage[] = [];
	const fileOps = createFileOps();
	let totalTokens = 0;

	// 第一遍：从全部 entry（即使超出 token 预算）收集文件操作。
	// 这确保能捕获嵌套 branch summary 带来的累计文件追踪。
	// 只从 pi 生成的摘要提取（fromHook !== true），扩展生成的不算
	for (const entry of entries) {
		if (entry.type === "branch_summary" && !entry.fromHook && entry.details) {
			const details = entry.details as BranchSummaryDetails;
			if (Array.isArray(details.readFiles)) {
				for (const f of details.readFiles) fileOps.read.add(f);
			}
			if (Array.isArray(details.modifiedFiles)) {
				// 修改过的文件同时进入 edited 与 written 以便正确去重
				for (const f of details.modifiedFiles) {
					fileOps.edited.add(f);
				}
			}
		}
	}

	// 第二遍：从最新到最旧遍历，加入消息直到 token 预算
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		const message = getMessageFromEntry(entry);
		if (!message) continue;

		// 从 assistant 消息（tool call）中提取文件操作
		extractFileOpsFromMessage(message, fileOps);

		const tokens = estimateTokens(message);

		// 加入前先检查预算
		if (tokenBudget > 0 && totalTokens + tokens > tokenBudget) {
			// 若是摘要 entry，则尽量将其容纳进来，因为它是重要上下文
			if (entry.type === "compaction" || entry.type === "branch_summary") {
				if (totalTokens < tokenBudget * 0.9) {
					messages.unshift(message);
					totalTokens += tokens;
				}
			}
			// 停下——已触及预算
			break;
		}

		messages.unshift(message);
		totalTokens += tokens;
	}

	return { messages, fileOps, totalTokens };
}

// ============================================================================
// 摘要生成
// ============================================================================

const BRANCH_SUMMARY_PREAMBLE = `The user explored a different conversation branch before returning here.
Summary of that exploration:

`;

const BRANCH_SUMMARY_PROMPT = `Create a structured summary of this conversation branch for context when returning later.

Use this EXACT format:

## Goal
[What was the user trying to accomplish in this branch?]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Work that was started but not finished]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [What should happen next to continue this work]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/**
 * 生成被放弃 branch entry 的摘要。
 *
 * @param entries - 待摘要的 session entry（按时间顺序）
 * @param options - 生成选项
 */
export async function generateBranchSummary(
	entries: SessionEntry[],
	options: GenerateBranchSummaryOptions,
): Promise<BranchSummaryResult> {
	const {
		model,
		apiKey,
		headers,
		env,
		signal,
		customInstructions,
		replaceInstructions,
		reserveTokens = 16384,
		streamFn,
		retry,
		callbacks,
	} = options;

	// token 预算 = 上下文窗口减去 prompt 与响应的预留空间
	const contextWindow = model.contextWindow || 128000;
	const tokenBudget = contextWindow - reserveTokens;

	const { messages, fileOps } = prepareBranchEntries(entries, tokenBudget);

	if (messages.length === 0) {
		return { summary: "No content to summarize" };
	}

	// 转换为 LLM 兼容的消息，然后序列化为文本。
	// 序列化可以防止模型把它当作一段要继续的对话
	const llmMessages = convertToLlm(messages);
	const conversationText = serializeConversation(llmMessages);

	// 构建 prompt
	let instructions: string;
	if (replaceInstructions && customInstructions) {
		instructions = customInstructions;
	} else if (customInstructions) {
		instructions = `${BRANCH_SUMMARY_PROMPT}\n\nAdditional focus: ${customInstructions}`;
	} else {
		instructions = BRANCH_SUMMARY_PROMPT;
	}
	const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${instructions}`;

	const summarizationMessages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: promptText }],
			timestamp: Date.now(),
		},
	];

	const maxTokens = Math.min(4096, model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY);

	// 调用 LLM 做摘要。优先使用 session 流函数，从而不经过 agent 状态/事件
	// 也能保持 SDK 请求行为（超时、重试、归属头）的一致性。经由 completeSummarization
	// 重试，瞬时流中断可复用已配置的重试策略。
	const context = normalizeContext({ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages });
	const requestOptions: SimpleStreamOptions = { apiKey, headers, env, signal, maxTokens };
	const response = await completeSummarization(model, context, requestOptions, streamFn, retry, callbacks);

	// 检查是否被取消或出错
	if (response.stopReason === "aborted") {
		return { aborted: true };
	}
	const failure = getSummarizationFailure(response, "Branch summarization");
	if (failure) {
		return { error: failure };
	}
	if (response.content.some((block) => block.type === "toolCall")) {
		return { error: "Branch summarization attempted to call a tool" };
	}

	let summary = contentText(response.content);

	// 在摘要前加上前导说明，提供 branch 摘要的上下文
	summary = BRANCH_SUMMARY_PREAMBLE + summary;

	// 计算文件列表并追加到摘要
	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	summary += formatFileOperations(readFiles, modifiedFiles);

	return {
		summary: summary || "No summary generated",
		usage: response.usage,
		readFiles,
		modifiedFiles,
	};
}
