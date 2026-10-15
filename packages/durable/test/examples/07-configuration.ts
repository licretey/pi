// 每个对话的代理选项和 Harness 级设置。
// 在 packages/durable 目录下运行：
//   node --conditions=source --experimental-strip-types test/examples/07-configuration.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	AgentDoc,
	createRegistry,
	defineExtension,
	defineTool,
	Harness,
	type HarnessSettings,
	MemoryStorage,
	section,
	type ToolRegistration,
} from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;

// 应用可以为工具附加自己的元数据，例如提示词片段。
type AppTool = ToolRegistration & { readonly snippet?: string };

function exampleTool(name: string, description: string): AppTool {
	const tool = defineTool({
		name,
		description,
		parameters: Type.Object({ path: Type.String() }),
		execute: async (args) => ({ output: [{ type: "text", text: `${name} ${args.path}` }] }),
	});
	return { ...tool, snippet: `Use ${name} for files.` };
}

const read = exampleTool("read", "Read a file");
const write = exampleTool("write", "Write a file");
const grep = exampleTool("grep", "Search files");
const Files = defineExtension<AppTool>({ name: "files", tools: [read, write] });
const Search = defineExtension<AppTool>({ name: "search", tools: [grep] });
// 分节会将提供的工具视为应用工具，因此可以渲染其提示词片段。
const Snippets = defineExtension<AppTool>({
	name: "snippets",
	sections: [section("tool_snippets", (input) => input.agent.tools.map((tool) => tool.snippet).join("\n"))],
});

const registry = createRegistry<AppTool>();
registry.install(Files);
registry.install(Search);
registry.install(Snippets);

// 设置是整个 Harness 共用的运行策略，每次使用时读取，不会持久化。
// getter 可让值保持实时更新，例如从应用设置文件读取的值。
let timeoutMs = 60_000;
const settings: HarnessSettings = {
	get stream() {
		return { timeoutMs };
	},
	retry: { maxRetries: 5 },
	toolExecution: "sequential",
};
const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry, settings }, context);
const root = await harness.root(context);

// 新对话不保存选项，而是遵循宿主配置：提供所有已安装扩展及其工具。
const tools = async () => (await root.agent(context)).tools.map((tool) => tool.name);
console.log("default tools:", await tools());

// configure() 会将选项保存到对话的 pi.agent 文档中，每次调用单独提交。
// 扩展和工具以对象形式传入，并按名称存储，从而避免名称拼写错误。
await root.configure(
	{
		model: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
		thinkingLevel: "high",
		tools: [write, read],
	},
	context,
);
console.log("stored:", await harness.snapshot(AgentDoc, root.id, context));
const agent = await root.agent(context);
console.log("model:", agent.model, "thinking:", agent.thinkingLevel, "tools:", await tools());

// 取消选择一个扩展；`null` 会清除已存储字段，使其恢复为宿主默认值。
await root.configure({ extensions: { remove: [Search] }, tools: null }, context);
console.log("without search:", await tools());

// 已保存的名称可以先于对应代码继续存在。对话仍选中这两个扩展；卸载 "files" 后，
// 该扩展仍处于选中状态，但在重新安装之前，请求不会再提供它的工具。
await root.configure({ extensions: [Files, Search] }, context);
registry.uninstall(Files);
console.log("files uninstalled:", await tools());
registry.install(Files);
console.log("files reinstalled:", await tools());

// 设置更改无需提交；下一次请求会使用新的超时时间。
timeoutMs = 120_000;

await harness.close(context);
