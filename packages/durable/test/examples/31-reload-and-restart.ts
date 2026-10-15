// 在调用执行期间重新加载扩展，然后重启进程。正在执行的工作会继续使用启动时的代码；存储的是扩展名称，
// 因此重启后仍可保留选择，并绑定到新进程所安装的代码。
// 在 packages/durable 目录下运行：
//   node --conditions=source --experimental-strip-types test/examples/31-reload-and-restart.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ToolResultMessage, Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, Harness, ToolResultEntry } from "../../src/index.ts";
import { openNodeSqliteStorage } from "../../src/storage/sqlite/node.ts";

const context = BACKGROUND_CONTEXT;

// 模拟从磁盘加载的代码：每次调用都会按文件当前内容创建扩展。
let started = (): void => {};
let gate = Promise.resolve();
function loadVersioned(version: string) {
	return defineExtension({
		name: "versioned",
		tools: [
			defineTool({
				name: "version",
				description: "Report the tool's code version",
				parameters: Type.Object({}),
				execute: async () => {
					started();
					await gate;
					return { output: [{ type: "text", text: version }] };
				},
			}),
		],
	});
}

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const callVersion = () => fauxAssistantMessage(fauxToolCall("version", {}), { stopReason: "toolUse" });
faux.setResponses([callVersion(), fauxAssistantMessage("Done."), callVersion(), fauxAssistantMessage("Done.")]);

const directory = await mkdtemp(join(tmpdir(), "pi-durable-reload-"));
const open = async (registry: ReturnType<typeof createRegistry>) =>
	Harness.open(await openNodeSqliteStorage(join(directory, "session.sqlite")), { models, registry }, context);

// 第一个进程。
let registry = createRegistry();
registry.install(loadVersioned("v1"));
let harness = await open(registry);
let root = await harness.root(context, {
	// 按名称选择。存储的是名称，而不是代码。
	agent: { model: { provider: "faux", modelId: "faux-1" }, extensions: [loadVersioned("v1")] },
});
const lastResult = async () => {
	const page = await root.entries({}, 10, undefined, context);
	const result = page.items.find((entry) => ToolResultEntry.is(entry))?.model?.[0] as ToolResultMessage;
	return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
};

// 调用执行期间文件发生变化：当前调用使用 v1 完成，下一次调用使用 v2。
let release = (): void => {};
gate = new Promise((resolve) => {
	release = resolve;
});
const running = new Promise<void>((resolve) => {
	started = resolve;
});
const submission = await root.submit({ type: "input", content: "Which version?" }, context);
await running;
registry.install(loadVersioned("v2"));
release();
await submission.wait(context);
console.log("call running during the reload:", await lastResult());
await (await root.submit({ type: "input", content: "And now?" }, context)).wait(context);
console.log("next call:", await lastResult());
await harness.close(context);

// 第二个进程：会话仍选择 "versioned"，但此进程尚未安装该扩展。
registry = createRegistry();
harness = await open(registry);
root = await harness.root(context);
const tools = async () => (await root.agent(context)).tools.map((tool) => tool.name);
console.log("after restart, before install:", await tools());
registry.install(loadVersioned("v3"));
console.log("after install:", await tools());

await harness.close(context);
await rm(directory, { recursive: true, force: true });
