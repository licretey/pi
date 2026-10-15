import type { Context } from "@earendil-works/chord";
import { type AssistantMessage, Type } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	configure,
	defineExtension,
	defineTool,
	type EntryId,
	type Extension,
	type ToolExecutionApi,
} from "@earendil-works/pi-durable";

async function answerText(api: ToolExecutionApi, answer: EntryId, context: Context): Promise<string> {
	const entry = await api.commit((tx) => tx.entry(AssistantEntry, answer), context);
	const message = entry?.model?.[0] as AssistantMessage | undefined;
	return message?.content.flatMap((content) => (content.type === "text" ? [content.text] : [])).join("") ?? "";
}

/**
 * 前台子代理：每次调用都会创建一个由该调用任务拥有的子会话，在其中执行任务并返回子会话的回答。
 * 中止调用时也会中止子会话。子会话的生命周期长于调用，因此用户可以切换到该会话并继续交流。
 */
export const Subagent: Extension = defineExtension({
	name: "subagent",
	tools: [
		defineTool({
			name: "subagent",
			description:
				"Delegate a self-contained task to a subagent with the same tools and get its answer back. Give it everything it needs to know; it does not see this conversation.",
			parameters: Type.Object({ task: Type.String({ description: "What the subagent should do" }) }),
			// 崩溃后重新运行时，会找到此前创建的子会话及提交内容。
			replay: "safe",
			execute: async (args, api, context) => {
				const child = await api.commit(async (tx) => {
					const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
					if (existing !== undefined) return existing.id;
					// 初始配置复制自当前会话的代理；未启用此扩展时，它无法继续委派任务。
					const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
					await configure(tx, created.id, { extensions: { remove: [Subagent] } });
					return created.id;
				}, context);
				await api.details({ conversationId: child }, context);
				const handle = (await api.conversation(child, context))!;
				const request = { type: "input", content: args.task, requestId: `subagent:${api.taskId}` } as const;
				const settled = await (await handle.submit(request, context)).wait(context);
				if (settled.status !== "done" || settled.type !== "input") {
					throw new Error(`Subagent ${child} failed: ${settled.status}`);
				}
				const text = await answerText(api, settled.answer, context);
				return { content: [{ type: "text", text }], details: { conversationId: child } };
			},
		}),
	],
});
