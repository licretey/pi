// 对话记录历史和模型上下文。
// 在 packages/durable 目录下运行：
//   node --conditions=source --experimental-strip-types test/examples/09-context.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, Message, StopReason, ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, MemoryStorage } from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;
const harness = await Harness.open(
	new MemoryStorage(),
	{ models: createModels(), registry: createRegistry() },
	context,
);

// 条目不可变。`model` 保存该条目为下一次模型请求提供的消息；`data` 仅供应用使用。context() 会将存储的对话记录
// 转换为请求消息，规则如下：
//   - 带有 `head` 的条目会开启新的上下文；较早条目仍会保留，
//   - `edits` 会替换或移除较早条目提供的内容，
//   - 已中止、出错或延迟的助手消息不会发送，
//   - 工具结果会按调用顺序紧跟在对应调用之后发送，
//   - 没有结果的调用会生成一个错误结果。
function assistantMessage(text: string, calls: readonly string[] = [], stopReason?: StopReason): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text },
			...calls.map((id) => ({ type: "toolCall" as const, id, name: "read", arguments: {} })),
		],
		api: "example",
		provider: "example",
		model: "example",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: stopReason ?? (calls.length > 0 ? "toolUse" : "stop"),
		timestamp: 2,
	};
}

function toolResultMessage(id: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content: [{ type: "text", text: `file ${id}` }],
		isError: false,
		timestamp: 3,
	};
}

function show(message: Message): string {
	switch (message.role) {
		case "user":
			return `user: ${message.content as string}`;
		case "system":
			return `system: ${JSON.stringify(message.sections)}`;
		case "assistant":
			return `assistant: ${message.content
				.map((part) => (part.type === "text" ? part.text : part.type === "toolCall" ? `call(${part.id})` : ""))
				.join(" ")}`;
		case "toolResult":
			return `result(${message.toolCallId})${message.isError ? " error" : ""}`;
	}
}

const transcript = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
const say = (kind: string, ...model: Message[]) =>
	transcript.commit((tx) => tx.appendEntry(transcript.id, { kind, model }), context);

const question = await say("message", { role: "user", content: "read a and b", timestamp: 1 });
await say("message", assistantMessage("I crashed", [], "aborted")); // stored, never sent
const calls = await say("message", assistantMessage("reading", ["a", "b"]));
await say("message", toolResultMessage("b")); // results finish out of order
await say("pi.system", { role: "system", content: "", sections: { cwd: "<cwd>/repo</cwd>" }, timestamp: 4 });
await say("message", toolResultMessage("a"));
await say("message", assistantMessage("a and b look fine"));
await transcript.commit(
	(tx) =>
		tx.appendEntry(transcript.id, {
			kind: "edit",
			data: "user fixed a typo",
			edits: [
				{
					target: question.id,
					action: "replace",
					messages: [{ role: "user", content: "read files a and b", timestamp: 1 }],
				},
			],
		}),
	context,
);
await transcript.commit((tx) => tx.appendEntry(transcript.id, { kind: "note", data: "display only" }), context);

let view = await transcript.context(context);
console.log(
	"raw active entries:",
	view.entries.map((entry) => entry.kind),
);
console.log("request messages:", view.messages.map(show));

// 从工具调用处创建的分支尚无工具结果；context() 会补全这些结果。
const cut = await transcript.fork(calls.id, { ownership: { kind: "ownerless" } }, context);
console.log("fork messages:", (await cut.context(context)).messages.map(show));

// 带有 head 的摘要会替代其指向条目之前的所有上下文。
// "self" 表示将 head 指向摘要条目本身。
await transcript.commit(
	(tx) =>
		tx.appendEntry(transcript.id, {
			kind: "summary",
			head: "self",
			model: [{ role: "user", content: "Summary: a and b are fine.", timestamp: 5 }],
		}),
	context,
);
view = await transcript.context(context);
console.log("after summary:", view.head?.kind, view.messages.map(show));

// entries() 会分页读取已存储的对话记录，按时间倒序排列，并包含从父对话继承的条目。
// head 和 edits 都不会删除任何条目。
const history = await transcript.entries({}, 3, undefined, context);
console.log(
	"newest stored entries:",
	history.items.map((entry) => entry.kind),
	"more:",
	history.next !== undefined,
);

await harness.close(context);
