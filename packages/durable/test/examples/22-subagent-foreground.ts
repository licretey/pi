// 前台子智能体工具：父级工具调用会创建一个由其拥有的子会话，在其中运行一个任务，并返回子会话的回答。
// 中止工具调用也会中止子会话。界面可通过工具的运行详情找到子会话，并在该调用下方显示其事件。
// 设置 OPENAI_API_KEY 时使用 OpenAI，否则使用脚本化的模拟模型。
// 在 packages/durable 目录下运行：
//   node --conditions=source --experimental-strip-types test/examples/22-subagent-foreground.ts
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type AssistantMessage, type FauxResponseStep, Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import {
	type AgentEvent,
	AssistantEntry,
	type ConversationId,
	configure,
	createRegistry,
	defineExtension,
	defineTool,
	type EntryId,
	type Extension,
	Harness,
	MemoryStorage,
	type ToolExecutionApi,
	watchEvents,
} from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;

// ─── 产品代码：子智能体扩展 ────────────────────────────────────────────────

async function answerText(api: ToolExecutionApi, answer: EntryId, callContext: Context): Promise<string> {
	const entry = await api.commit((tx) => tx.entry(AssistantEntry, answer), callContext);
	const message = entry?.model?.[0] as AssistantMessage;
	return message.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
}

const Subagent: Extension = defineExtension({
	name: "subagent",
	tools: [
		defineTool({
			name: "subagent",
			description: "Delegate a self-contained task to a subagent and get its answer back.",
			parameters: Type.Object({ task: Type.String({ description: "What the subagent should do" }) }),
			// 崩溃后可安全重试：重试会找到已创建的子会话和已提交的请求。
			replay: "safe",
			execute: async (args, api, callContext) => {
				const { task } = args;
				// 子会话由此工具调用对应的任务拥有，因此中止调用会同时中止子会话；只有子任务完成后调用才会结束。
				const child = await api.commit(async (tx) => {
					// 所有权关系会记录该子会话，因此重试时能找到它，不会重复创建。
					const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
					if (existing !== undefined) return existing.id;
					// 初始配置复制自当前会话的 agent：模型、思考级别、cwd、扩展和工具。
					const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
					// 移除此扩展后，子会话将无法使用该工具。
					await configure(tx, created.id, { extensions: { remove: [Subagent] } });
					return created.id;
				}, callContext);
				// 监视父会话的界面会收到此详情，并可连接到子会话。
				await api.details({ conversationId: child }, callContext);

				const handle = (await api.conversation(child, callContext))!;
				// 请求 ID 可确保重试时取回崩溃前已提交的请求。
				const request = { type: "input", content: task, requestId: `subagent:${api.taskId}` } as const;
				const settled = await (await handle.submit(request, callContext)).wait(callContext);
				if (settled.status !== "done" || settled.type !== "input") {
					throw new Error(`Subagent failed: ${settled.status}`);
				}
				const text = await answerText(api, settled.answer, callContext);
				return { output: [{ type: "text", text }], details: { conversationId: child } };
			},
		}),
	],
});

// ─── 宿主环境设置 ───────────────────────────────────────────────────────────

const models = createModels();
let model = { provider: "openai", modelId: "gpt-6-sol" };
if (process.env.OPENAI_API_KEY !== undefined) {
	models.setProvider(openaiProvider());
} else {
	// 父会话委派任务，子会话作答，然后父会话汇报结果。
	const faux = fauxProvider();
	models.setProvider(faux.provider);
	model = { provider: "faux", modelId: "faux-1" };
	const delegate = fauxToolCall("subagent", { task: "Name three prime numbers." }, { id: "call-1" });
	faux.setResponses([
		fauxAssistantMessage([delegate], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("2, 3, and 5.")]),
		fauxAssistantMessage([fauxText("The subagent says: 2, 3, and 5.")]),
	] satisfies FauxResponseStep[]);
}
const registry = createRegistry();
registry.install(Subagent);
const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
const root = await harness.root(context, { agent: { model } });

// ─── 界面：父会话事件，以及缩进显示在对应调用下的子智能体事件 ───────────────

const print = (indent: string, event: AgentEvent): void => {
	if (event.type === "message_end" && event.entry.kind === "pi.assistant") {
		const message = event.entry.model?.[0] as AssistantMessage;
		const text = message.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
		if (text !== "") console.log(`${indent}assistant: ${text}`);
	} else if (event.type === "tool_execution_start") {
		console.log(`${indent}tool ${event.toolName}(${JSON.stringify(event.args)})`);
	}
};
const attached = new Set<ConversationId>();
const attach = async (id: ConversationId, indent: string): Promise<void> => {
	attached.add(id);
	const stream = await watchEvents(harness, id, context);
	stream.start(async (events) => {
		for (const event of events) {
			print(indent, event);
			if (event.type !== "tool_execution_update") continue;
			const child = (event.details as { conversationId?: ConversationId } | undefined)?.conversationId;
			if (child !== undefined && !attached.has(child)) await attach(child, `${indent}  `);
		}
	});
};
await attach(root.id, "");

const submission = await root.submit(
	{ type: "input", content: "Use the subagent tool to find three prime numbers, then tell me what it said." },
	context,
);
await submission.wait(context);
await harness.waitForIdle(context);
// 事件回调会在提交后运行；等待最后几个回调完成输出。
await new Promise((resolve) => setTimeout(resolve, 0));
await harness.close(context);
