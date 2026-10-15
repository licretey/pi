// 使用扩展注册表打开 Harness。
// 在 packages/durable 目录下运行：
//   node --conditions=source --experimental-strip-types test/examples/06-harness.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	AgentDoc,
	createRegistry,
	defineDoc,
	defineExtension,
	defineTool,
	Harness,
	MemoryStorage,
} from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;

// Harness 由 Session、对话句柄和持久化任务组成。扩展代码（工具、提示词分节、钩子和任务）
// 通过带名称的扩展提供，并安装在应用管理的注册表中。注册表中的内容不会保存；它们属于当前进程的代码。
const read = defineTool({
	name: "read",
	description: "Read a file",
	parameters: Type.Object({ path: Type.String() }),
	execute: async (args) => ({ output: [{ type: "text", text: `contents of ${args.path}` }] }),
});
const Files = defineExtension({ name: "files", tools: [read] });
const registry = createRegistry();
registry.install(Files);

// `models` 是 pi-ai 提供的模型访问接口，生成请求会通过它调用模型。
const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry }, context);

const Notes = defineDoc<{ text: string }>({
	kind: "example.notes",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ text: "" }),
});

// 根对话的 ID 始终为 1。首次调用 root() 时，会在同一事务中创建根对话、内置文档、`agent` 选项以及 `init` 写入的内容。
// 后续调用（包括进程重启后）都会返回该根对话，并忽略这两个选项。
const root = await harness.root(context, {
	agent: { thinkingLevel: "low" },
	init: async (tx, rootId) => {
		(await tx.doc(Notes, rootId)).text = "root notes";
	},
});
console.log("root:", root.id, await harness.snapshot(Notes, root.id, context));
// 保存的选项是名称；agent() 会根据注册表解析这些名称。
console.log("stored agent:", await harness.snapshot(AgentDoc, root.id, context));
const agent = await root.agent(context);
console.log(
	"resolved:",
	agent.thinkingLevel,
	agent.extensions.map((extension) => extension.name),
	agent.tools.map((tool) => tool.name),
);

await harness.close(context);
