import type { Context } from "@earendil-works/chord";
import { uuidv7 } from "@earendil-works/pi-ai/utils/uuid";
import { defineDoc } from "../documents.ts";
import type { TaskRuntime } from "../types.ts";

/** 单个对话面向提供方的稳定身份。 */
export type ProviderState = {
	sessionId: string;
};

/** 内建的提供方状态；每个分叉都以全新身份开始，而不是复制其父。 */
export const ProviderDoc = defineDoc<ProviderState>({
	kind: "pi.provider",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ sessionId: uuidv7() }),
	checkpointWhen: () => true,
});

/**
 * 在正常路径下直接返回持久化的身份，而不写入。没有 `pi.provider` 的旧版对话会得到一次迁移提交，
 * 其 `tx.doc()` 会在提供方请求开始之前执行 `initial()`。
 */
export async function ensureProviderSessionId<I, S, R, H extends object>(
	runtime: TaskRuntime<I, S, R, H>,
	context: Context,
): Promise<string> {
	const existing = await runtime.snapshot(ProviderDoc, runtime.conversationId, context);
	if (existing !== undefined) return existing.sessionId;
	let created: string | undefined;
	await runtime.commit(async (tx) => {
		created = (await tx.doc(ProviderDoc, runtime.conversationId)).sessionId;
		return undefined;
	}, context);
	if (created === undefined) throw new Error(`Conversation ${runtime.conversationId} has no provider session ID`);
	return created;
}
