// 一个简易编码智能体：使用内置编码工具、能够读取工作目录的提示词、由应用设置文件提供的配置，
// 以及随会话目录变化的执行环境。
// 在 packages/durable 目录下运行：
//   node --conditions=source --experimental-strip-types test/examples/26-coding-agent.ts
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { NodeExecutionEnv } from "../../src/env/node.ts";
import {
	createRegistry,
	defineExtension,
	Harness,
	type HarnessSettings,
	MemoryStorage,
	section,
	ToolResultEntry,
} from "../../src/index.ts";
import { CodingTools } from "../../src/tools/index.ts";

const context = BACKGROUND_CONTEXT;
const workspace = await mkdtemp(join(tmpdir(), "pi-durable-agent-"));
await mkdir(join(workspace, "app"));

// 在编码工具旁边定义应用自己的提示词。
const Coding = defineExtension({
	name: "coding",
	sections: [
		section("preamble", () => "You are a coding agent. Use the tools to inspect the project.", { tag: false }),
		section("cwd", (input) => input.env?.cwd),
	],
});
const registry = createRegistry();
registry.install(CodingTools);
registry.install(Coding);

// 用户可在智能体运行期间更改这些设置，例如由应用监视的 settings.json。getter 可确保 Harness 每次读取时
// 都看到文件中的最新值；设置不会被复制或存储。
const userSettings = { parallelTools: true, maxRetries: 3 };
const settings: HarnessSettings = {
	get toolExecution() {
		return userSettings.parallelTools ? "parallel" : "sequential";
	},
	get retry() {
		return { maxRetries: userSettings.maxRetries };
	},
};

// Harness 会在每次工具调用和请求时，使用会话的 `cwd` 调用此函数，因此更改会话目录无需重启。
const env = ({ cwd = workspace }: { readonly cwd?: string }) => new NodeExecutionEnv({ cwd });

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const pwd = () => fauxAssistantMessage(fauxToolCall("bash", { command: "pwd" }), { stopReason: "toolUse" });
faux.setResponses([pwd(), fauxAssistantMessage("Done."), pwd(), fauxAssistantMessage("Done.")]);

const harness = await Harness.open(new MemoryStorage(), { models, registry, settings, env }, context);
const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: workspace } });

const lastBashOutput = async () => {
	const page = await root.entries({}, 10, undefined, context);
	const result = page.items.find((entry) => ToolResultEntry.is(entry))?.model?.[0] as ToolResultMessage;
	return result.content.map((part) => (part.type === "text" ? part.text.trim() : "")).join("");
};

await (await root.submit({ type: "input", content: "Where are we?" }, context)).wait(context);
console.log("bash ran in:", await lastBashOutput());

// 用户切换项目目录并关闭并行工具；两项更改都会从下一次调用开始生效。
await root.configure({ cwd: join(workspace, "app") }, context);
userSettings.parallelTools = false;
await (await root.submit({ type: "input", content: "And now?" }, context)).wait(context);
console.log("bash ran in:", await lastBashOutput());

await harness.close(context);
await rm(workspace, { recursive: true, force: true });
