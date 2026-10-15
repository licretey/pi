// 上下文压缩示例：在长篇旅行规划对话中概括较早的消息，以控制模型上下文大小。
// 在 packages/durable 目录下运行：
//   node --conditions=source --experimental-strip-types test/examples/25-compaction.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, Message, TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
	CompactionEntry,
	type Conversation,
	createRegistry,
	Harness,
	LiveDoc,
	MemoryStorage,
} from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;

// 模拟模型的上下文窗口只有 3000 个令牌。它会回答聊天消息、按要求生成摘要，
// 并模拟真实提供商报告上下文溢出：有一次会以请求过长为由拒绝请求。
let overflowOnce = false;
let summaries = 0;
// 设置此门闩后，下一条聊天回答会等待放行，使会话保持忙碌状态。
let hold: Promise<void> | undefined;
async function respond(transcript: TranscriptContext): Promise<AssistantMessage> {
	const first = transcript.messages[0];
	if (first?.role === "system" && typeof first.content === "string" && first.content.includes("summarization")) {
		summaries++;
		return fauxAssistantMessage(`## Goal\nPlan a week in Lisbon (summary #${summaries}).`);
	}
	if (overflowOnce) {
		overflowOnce = false;
		return fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long" });
	}
	const held = hold;
	hold = undefined;
	await held;
	const question = transcript.messages.findLast((message) => message.role === "user");
	return fauxAssistantMessage(`A detailed answer to "${text(question)}": ${"details ".repeat(200)}`);
}
const faux = fauxProvider({ models: [{ id: "tiny", contextWindow: 3000, maxTokens: 1000 }] });
faux.setResponses(Array.from({ length: 100 }, () => respond));
const models = createModels();
models.setProvider(faux.provider);

// generation 会在超过 3000 - 1000 = 2000 个令牌时阻塞并启动压缩；超过 2000 - 800 时启动后台压缩。
// 设置项在每次使用时读取，因此 getter 可让 `backgroundTokens` 的更改立即生效。
let backgroundTokens = 800;
const settings = {
	get compaction() {
		return { reserveTokens: 1000, keepRecentTokens: 400, backgroundTokens };
	},
};
const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry(), settings }, context);
const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "tiny" } } });

async function ask(question: string): Promise<void> {
	const submission = await root.submit({ type: "input", content: question }, context);
	const record = await submission.wait(context);
	// 等待本轮启动的后台压缩完成，以便在下方显示其摘要。
	const running = (await harness.snapshot(LiveDoc, root.id, context))?.compactions ?? [];
	for (const { taskId } of running) await harness.waitForTask(taskId, context);
	await show(root, `after "${question}" (${record.status === "done" ? "answered" : record.reason})`);
}

// 1. 长对话：上下文超过后台阈值后，压缩会与对话并行运行；会话空闲时立即放置摘要，
// 否则等到下一轮边界再放置。
for (const question of [
	"Where should we stay?",
	"What should we eat?",
	"Which day trips?",
	"Any museums?",
	"Nightlife?",
]) {
	await ask(question);
}

// 2. 在回答仍在生成时手动压缩。摘要会先准备好并等待在收件箱中，随后紧接回答放置。
let finishAnswer!: () => void;
hold = new Promise((resolve) => {
	finishAnswer = resolve;
});
const busy = await root.submit({ type: "input", content: "How do we get around?" }, context);
const manual = await root.compact("Keep the hotel shortlist", context);
const { state } = await harness.waitForTask(manual, context);
const placement = state.outcome.status === "completed" ? state.outcome.result.submissionId : undefined;
const summary = (await harness.submission(placement!, context))!;
console.log("\nmanual compaction finished; its summary is", (await summary.status(context)).status);
finishAnswer();
await busy.wait(context);
console.log("after the answer, the summary is", (await summary.wait(context)).status);
await show(root, "after compact()");

// 3. 提供商因请求过长而拒绝请求时，generation 会先压缩上下文，再重试一次。此处关闭后台压缩，
// 因此下方的摘要是由溢出触发的。
backgroundTokens = 0;
await ask("What should we pack?");
overflowOnce = true;
await ask("Summarize the plan for my partner");

await harness.close(context);

/** 打印模型上下文：每条消息占一行，并显示其对应的已存储条目数。 */
async function show(conversation: Conversation, label: string): Promise<void> {
	const view = await conversation.context(context);
	const stored = (await conversation.entries({}, 1000, undefined, context)).items.length;
	console.log(`\n${label}: ${view.messages.length} messages in context, ${stored} entries stored`);
	const reason = CompactionEntry.is(view.head) ? view.head.data.reason : undefined;
	if (reason !== undefined) console.log(`  (${reason} compaction summary first)`);
	for (const message of view.messages) {
		console.log(
			`  ${message.role.padEnd(9)} ${message.role === "system" ? "(system prompt)" : text(message).slice(0, 70)}`,
		);
	}
}

function text(message: Message | undefined): string {
	if (message === undefined || message.role === "system") return "";
	if (typeof message.content === "string") return message.content;
	const block = message.content.find((content) => content.type === "text");
	return block?.type === "text" ? block.text.replaceAll("\n", " ") : "";
}
