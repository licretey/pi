// 计划模式：用户将对话切换为只读规划模式，智能体会把计划写入
// 扩展自己的文档中，切回普通模式后会恢复完整工具集。
// 在 packages/durable 目录下运行：
//   node --conditions=source --experimental-strip-types test/examples/27-plan-mode.ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { NodeExecutionEnv } from "../../src/env/node.ts";
import {
	createRegistry,
	defineDoc,
	defineExtension,
	defineTool,
	Harness,
	MemoryStorage,
	section,
} from "../../src/index.ts";
import { CodingTools, createReadTool } from "../../src/tools/index.ts";

const context = BACKGROUND_CONTEXT;

// ─── 产品代码：计划扩展 ────────────────────────────────────────────────────

// 对话的当前计划。分支会保留创建分支的条目对应的计划。
const PlanDoc = defineDoc<{ steps: string[] }>({
	kind: "app.plan",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ steps: [] }),
});

const submitPlan = defineTool({
	name: "submit_plan",
	description: "Submit the plan as a list of steps.",
	parameters: Type.Object({ steps: Type.Array(Type.String()) }),
	execute: async (args, api, callContext) => {
		await api.commit(async (tx) => {
			(await tx.doc(PlanDoc, api.conversationId)).steps = args.steps;
		}, callContext);
		return { output: [{ type: "text", text: "Plan submitted." }], control: { terminate: true } };
	},
});

const Plan = defineExtension({
	name: "plan",
	tools: [submitPlan],
	sections: [
		section("plan_mode", () => "You are in plan mode. Read the code, then call submit_plan. Change nothing."),
	],
});

// 计划模式会更改对话使用的智能体：选择 plan 扩展，并只提供读取和
// submit_plan 工具。清空这两项设置后，会恢复宿主的默认选择和全部工具。
const read = createReadTool();
const enterPlanMode = { extensions: { add: [Plan] }, tools: [read, submitPlan] };
const leavePlanMode = { extensions: null, tools: null };

// ─── Host setup ─────────────────────────────────────────────────────────────

const directory = await mkdtemp(join(tmpdir(), "pi-durable-plan-"));
await writeFile(join(directory, "server.ts"), "app.listen(3000);\n");

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([
	fauxAssistantMessage(fauxToolCall("read", { path: "server.ts" }), { stopReason: "toolUse" }),
	fauxAssistantMessage(fauxToolCall("submit_plan", { steps: ["Read PORT from the environment", "Default to 3000"] }), {
		stopReason: "toolUse",
	}),
	fauxAssistantMessage("Implementing step 1."),
]);

const registry = createRegistry();
registry.install(CodingTools);
registry.install(Plan);
const harness = await Harness.open(
	new MemoryStorage(),
	// 扩展虽已安装，但默认只选择 CodingTools；对话需显式选择 plan mode。
	{ models, registry, settings: { extensions: [CodingTools] }, env: () => new NodeExecutionEnv({ cwd: directory }) },
	context,
);
const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
const tools = async () => (await root.agent(context)).tools.map((tool) => tool.name);
console.log("tools:", await tools());

await root.configure(enterPlanMode, context);
console.log("plan mode tools:", await tools());
await (await root.submit({ type: "input", content: "Make the port configurable." }, context)).wait(context);
console.log("plan:", (await harness.snapshot(PlanDoc, root.id, context))?.steps);

await root.configure(leavePlanMode, context);
console.log("tools again:", await tools());
await (await root.submit({ type: "input", content: "Go ahead." }, context)).wait(context);

// 模型在对话记录中会将每次切换视为系统提示词变更。
const { messages } = await root.context(context);
for (const message of messages) {
	if (message.role !== "system") continue;
	console.log("system:", {
		// 将分节值设为 null 即可移除该分节。
		sections: message.sections,
		added: message.toolsAdded?.map((tool) => tool.name),
		removed: message.toolsRemoved?.map((tool) => tool.name),
	});
}

await harness.close(context);
await rm(directory, { recursive: true, force: true });
