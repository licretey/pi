// 对话句柄、类型化条目、新建对话和分叉。
// 在 packages/durable 目录下运行：
//   node --conditions=source --experimental-strip-types test/examples/08-harness-conversations.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineEntry, Harness, MemoryStorage } from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;
const harness = await Harness.open(
	new MemoryStorage(),
	{ models: createModels(), registry: createRegistry() },
	context,
);
const root = await harness.root(context);
await root.configure({ thinkingLevel: "high" }, context);

// 对话句柄没有内部状态，应按 ID 比较。它们会将提交绑定到
// 到对应的 conversation。条目令牌会为条目种类的 `data` 提供类型。
const Message = defineEntry<{ from: string }>("message");
const hello = await root.commit(
	(tx) =>
		tx.appendEntry(Message, root.id, {
			data: { from: "example" },
			model: [{ role: "user", content: "hello", timestamp: 1 }],
		}),
	context,
);
console.log("typed entry:", Message.is(hello), hello.data.from);

// createConversation() 和 fork() 会应用 `agent` 配置，并在
// 创建提交。分叉会从父 conversation 在分叉时使用的智能体开始，
// 新建条目中运行 init。
const helper = await harness.createConversation(
	{ ownership: { kind: "ownerless" }, agent: { thinkingLevel: "minimal" } },
	context,
);
const retry = await root.fork(hello.id, { ownership: { kind: "ownerless" } }, context);
console.log("helper thinking:", (await helper.agent(context)).thinkingLevel);
console.log("fork thinking:", (await retry.agent(context)).thinkingLevel);
console.log("lookup:", (await harness.conversation(retry.id, context))?.id === retry.id);

await harness.close(context);
