/**
 * Jev 路由器：使用高性能模型制定计划，再由低成本模型执行。
 *
 * 注册 `jev/auto`，在三个 OpenAI Codex 模型之间进行路由：
 *
 * - 规划：复杂任务使用 GPT-5.6 Sol，其他任务使用 GPT-5.6 Terra。Jev 分类器会评估
 *   用户的第一条消息；整个规划阶段都使用选定的模型。
 * - 执行：使用 GPT-5.6 Luna。
 *
 * 规划模型负责探索、制定计划并完成首次编辑。首次成功调用 `edit` 或 `write` 工具后，
 * 同一轮中的下一次请求会交给 Luna，之后该会话继续使用 Luna。因此，每个会话只切换一次模型，
 * 只会遇到一次提示缓存未命中。
 *
 * 阶段属于路由状态：Pi 会将其存储在会话分支中，因此它会随会话树保留，并能跨越压缩。
 * 选定的思考级别会作为所选模型的推理强度传递。智能体循环之外的请求（例如压缩摘要）会交给 Luna。
 *
 * 需要 TypeSafe 凭据（TYPESAFE_API_KEY）和 OpenAI Codex 登录状态。
 * 用法：pi -e ./jev-router.ts --model jev/auto
 */

import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ModelRoute, ModelRouteRequest } from "@earendil-works/pi-coding-agent";

const PROVIDER = "openai-codex";
const SOL = "gpt-5.6-sol";
const TERRA = "gpt-5.6-terra";
const LUNA = "gpt-5.6-luna";

/** 成功执行后表示实现阶段已开始的工具。 */
const EDIT_TOOLS = new Set(["edit", "write"]);

interface JevState {
	phase: "planning" | "implementation";
	/** 此阶段使用的 OpenAI Codex 模型。 */
	model: string;
}

type JevRequest = ModelRouteRequest<JevState>;

function routeTo(request: JevRequest, ctx: ExtensionContext, id: string, state?: JevState): ModelRoute<JevState> {
	const model = ctx.modelRegistry.find(PROVIDER, id);
	if (!model) throw new Error(`Model ${PROVIDER}/${id} is not in the catalog`);
	return { model, thinkingLevel: request.thinkingLevel, state };
}

function lastUserText(messages: readonly Message[]): string {
	const content = messages.filter((message) => message.role === "user").at(-1)?.content ?? "";
	if (typeof content === "string") return content;
	return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

/** 自最近一条用户消息以来，是否有工具调用成功编辑了文件。 */
function editedThisTurn(messages: readonly Message[]): boolean {
	const lastUser = messages.findLastIndex((message) => message.role === "user");
	return messages
		.slice(lastUser + 1)
		.some((message) => message.role === "toolResult" && EDIT_TOOLS.has(message.toolName) && !message.isError);
}

/** 新会话使用的规划模型：复杂任务用 Sol，否则或 Jev 不可用时用 Terra。 */
async function choosePlanningModel(request: JevRequest, ctx: ExtensionContext): Promise<string> {
	// 如果会话已在使用规划模型，则继续使用它，避免切换到 jev/auto 时发生缓存未命中。
	const previous = request.previous?.model;
	if (previous?.provider === PROVIDER && (previous.id === SOL || previous.id === TERRA)) return previous.id;

	const jev = ctx.modelRegistry.findOfType("classifier", "typesafe", "jev-latest");
	if (!jev) return TERRA;
	const result = await ctx.modelRegistry.classify(
		jev,
		{
			state: { prompt: lastUserText(request.messages).slice(0, 16_000) },
			questions: {
				complexity: {
					type: "choice",
					instructions: "How demanding is the software engineering work requested in `prompt`?",
					criteria: {
						standard: "Ordinary features, fixes, reviews, or questions",
						complex: "Subtle design, cross-cutting changes, or hard debugging",
					},
				},
			},
		},
		{ signal: request.signal },
	);
	const answer = result.stopReason === "stop" ? result.answers.complexity : undefined;
	return answer?.type === "choice" && (answer.probabilities.complex ?? 0) >= 0.5 ? SOL : TERRA;
}

export default function (pi: ExtensionAPI) {
	pi.registerVirtualModel<JevState>({
		provider: "jev",
		id: "auto",
		name: "Auto (Jev)",
		thinkingLevels: ["low", "medium", "high", "xhigh"],
		// 三个模型共用；在首次响应前显示。
		contextWindow: 272_000,
		maxTokens: 128_000,
		async route(request, ctx) {
			if (request.reason === "direct") return routeTo(request, ctx, LUNA);
			const state = request.state;
			if (!state) {
				const model = await choosePlanningModel(request, ctx);
				return routeTo(request, ctx, model, { phase: "planning", model });
			}
			// 规划模型已完成首次编辑：将后续工作交给 Luna。
			if (state.phase === "planning" && editedThisTurn(request.messages)) {
				return routeTo(request, ctx, LUNA, { phase: "implementation", model: LUNA });
			}
			return routeTo(request, ctx, state.model);
		},
	});
}
