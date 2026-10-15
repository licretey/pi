// 通过注册表重新加载扩展代码。
// 在 packages/durable 目录下运行：
//   node --conditions=source --experimental-strip-types test/examples/10-registry-reload.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineExtension, defineTool, Harness, MemoryStorage, wrapTool } from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;

function exampleTool(name: string, description: string) {
	return defineTool({
		name,
		description,
		parameters: Type.Object({ path: Type.String() }),
		execute: async (args) => ({ output: [{ type: "text", text: `${name} ${args.path}` }] }),
	});
}

const read = exampleTool("read", "Read a file");
const registry = createRegistry();
registry.install(defineExtension({ name: "files", tools: [read, exampleTool("grep", "Search files")] }));
const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry }, context);
const root = await harness.root(context);
const tools = async () => (await root.agent(context)).tools.map((tool) => `${tool.name}: ${tool.description}`);

// 重新加载时安装一个同名的新对象：它会在一次发布中原位替换旧对象，因此对话不会观察到扩展缺失。
// 已经开始的任务阶段会继续使用其获取的快照；下一阶段
// 则使用新代码。
registry.install(defineExtension({ name: "files", tools: [read, exampleTool("grep", "Search files, faster")] }));
console.log("after reload:", await tools());

// 其他扩展可以按名称包装工具。只有选用了包装扩展的地方才会应用包装；即使被包装工具重新加载，包装仍然有效。
const Audit = defineExtension({
	name: "audit",
	wraps: [wrapTool(read, (tool) => ({ ...tool, description: `${tool.description} (audited)` }))],
});
registry.install(Audit);
console.log("with audit:", await tools());

// 卸载操作会按名称移除扩展；选择该扩展的对话将不再获得它提供的代码。
registry.uninstall(Audit);
console.log("after uninstall:", await tools());

await harness.close(context);
