// 为每个对话维护独立文档的扩展。
// 在 packages/durable 目录下运行：
//   node --conditions=source --experimental-strip-types test/examples/11-extension-state.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	createRegistry,
	defineDoc,
	defineExtension,
	defineTool,
	Harness,
	MemoryStorage,
	section,
} from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;

// 每个对话各有一份待办列表。`asOf` 会保留历史值，因此分支从创建分支的条目对应的待办列表开始。
const Todos = defineDoc<{ items: string[] }>({
	kind: "example.todos",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ items: [] }),
});

// 工具负责写入文档；分节会在每次请求前将其展示给模型。无需预先创建文档：tx.doc() 首次写入时会创建它，
// 而分节会将不存在的文档视为空列表。
const Todo = defineExtension({
	name: "todo",
	tools: [
		defineTool({
			name: "todo",
			description: "Add an item to your todo list",
			parameters: Type.Object({ item: Type.String() }),
			execute: async (args, api, callContext) => {
				await api.commit(async (tx) => {
					(await tx.doc(Todos, api.conversationId)).items.push(args.item);
				}, callContext);
				return { output: [{ type: "text", text: `added ${args.item}` }] };
			},
		}),
	],
	sections: [
		section("todos", async (input, renderContext) => {
			const todos = await input.read.snapshot(Todos, input.conversationId, renderContext);
			return todos === undefined || todos.items.length === 0 ? undefined : todos.items.join("\n");
		}),
	],
});

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const registry = createRegistry();
registry.install(Todo);
const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });

faux.setResponses([
	fauxAssistantMessage(fauxToolCall("todo", { item: "fix the build" }), { stopReason: "toolUse" }),
	fauxAssistantMessage("Noted."),
	fauxAssistantMessage("Working on it."),
]);
await (await root.submit({ type: "input", content: "Remember to fix the build." }, context)).wait(context);
console.log("todos:", await harness.snapshot(Todos, root.id, context));

// 下一次请求的系统提示词会包含该列表。第一条系统消息只声明了 todo 工具，当时分节还没有文本内容。
await (await root.submit({ type: "input", content: "What is next?" }, context)).wait(context);
const { messages } = await root.context(context);
console.log(
	"system messages:",
	messages.flatMap((message) =>
		message.role === "system"
			? [{ sections: message.sections, toolsAdded: message.toolsAdded?.map((tool) => tool.name) }]
			: [],
	),
);

await harness.close(context);
