import { type Context, defineService } from "@earendil-works/chord";

export interface AgentPromptImage {
	type: "image";
	data: string;
	mimeType: string;
}

export interface AgentPromptRequest {
	message: string;
	images: AgentPromptImage[] | null;
}

export interface AgentOperationError {
	code: string;
	message: string;
}

/** `operationId` 标识提示词的持久化提交，或压缩任务。 */
export type AgentOperationResponse =
	| { accepted: true; operationId: string; error: null }
	| { accepted: false; operationId: null; error: AgentOperationError };

/** `entryId` 标识持久化提交；若提交仍在队列中，`cancelQueued()` 会撤回它。 */
export type AgentQueueResponse =
	| { accepted: true; entryId: string; error: null }
	| { accepted: false; entryId: null; error: AgentOperationError };

/** 提示词处理结束后的结果：回答文本，或未能获得回答的原因。 */
export type AgentPromptResult =
	| { status: "done"; text: string; reason: null }
	| { status: "unanswered"; text: null; reason: string };

export interface AgentCompactionRequest {
	customInstructions: string | null;
}

/** 面向呈现层的安全命令门面，用于操作由工作进程管理的根会话。 */
export interface AgentController {
	/** 启动一次运行；已有运行进行时会以 `busy` 拒绝。 */
	prompt(request: AgentPromptRequest, context: Context): Promise<AgentOperationResponse>;
	/** 引导当前运行；空闲时则启动一次运行。 */
	steer(request: AgentPromptRequest, context: Context): Promise<AgentQueueResponse>;
	/** 将输入排入当前运行之后；空闲时则启动一次运行。 */
	followUp(request: AgentPromptRequest, context: Context): Promise<AgentQueueResponse>;
	cancelQueued(
		entryId: string,
		context: Context,
	): Promise<{ outcome: "cancelled" | "already_consumed" | "not_found" }>;
	/** 撤回排队中的输入，并中止当前运行和压缩任务。 */
	abort(context: Context): Promise<void>;
	compact(request: AgentCompactionRequest, context: Context): Promise<AgentOperationResponse>;
	/** 等待此 `operationId` 对应的提示词得到回答，或以未回答状态结束。 */
	waitForPrompt(operationId: string, context: Context): Promise<AgentPromptResult>;
}

export const AgentController = defineService<AgentController>("pi.agent-controller");
