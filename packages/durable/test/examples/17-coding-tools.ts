// 展示 coding-agent 工具如何使用 JSONL 存储完成一轮操作：模型读取和编辑文件、运行命令，然后作答。
// 钩子会统计 `cat /tmp/1gb.txt` 的耗时（需先创建该文件才能测量；否则调用会返回错误结果）。存储目录会保留以供检查。
// 在 packages/durable 目录下运行：
//   node --conditions=source --experimental-strip-types test/examples/17-coding-tools.ts
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { NodeExecutionEnv } from "../../src/env/node.ts";
import {
	AssistantEntry,
	createRegistry,
	defineExtension,
	Harness,
	hook,
	ToolResultEntry,
	ToolTask,
} from "../../src/index.ts";
import { openNodeJsonlStorage } from "../../src/storage/jsonl/node.ts";
import { type BashToolInput, CodingTools } from "../../src/tools/index.ts";

const context = BACKGROUND_CONTEXT;
const directory = await mkdtemp(join(tmpdir(), "pi-durable-example-"));
await writeFile(join(directory, "notes.txt"), "hello world\n");

// 模拟提供商扮演模型：先返回四个调用工具的回答，再返回最终回答。
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const toolCall = (name: string, args: Parameters<typeof fauxToolCall>[1], id: string) =>
	fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: "toolUse" });
faux.setResponses([
	toolCall("read", { path: "notes.txt" }, "r"),
	toolCall("edit", { path: "notes.txt", edits: [{ oldText: "world", newText: "durable" }] }, "e"),
	toolCall("bash", { command: "cat notes.txt" }, "b"),
	toolCall("bash", { command: "cat /tmp/1gb.txt" }, "c"),
	fauxAssistantMessage([fauxText("The file now greets durable.")]),
]);

// 钩子会在每次调用执行前后收到通知；此处用于统计大型 `cat` 命令的耗时。
const isBigCat = (call: { name: string; arguments: unknown }) =>
	call.name === "bash" && (call.arguments as BashToolInput).command.includes("1gb.txt");
let start = 0;
const Timing = defineExtension({
	name: "timing",
	hooks: [
		hook(ToolTask, {
			beforeTool: (call) => {
				if (isBigCat(call)) start = Date.now();
				return undefined;
			},
			afterTool: (call) => {
				if (isBigCat(call)) console.log(`cat /tmp/1gb.txt took ${Date.now() - start} ms`);
				return undefined;
			},
		}),
	],
});
const registry = createRegistry();
// CodingTools 提供 read、write、edit 和 bash。工具只能通过 Harness 为每次调用创建的环境访问文件和进程。
registry.install(CodingTools);
registry.install(Timing);

// 执行环境会在每次使用时创建，并遵循对话代理的 `cwd`。
const storage = await openNodeJsonlStorage(directory, context);
const harness = await Harness.open(
	storage,
	{ models, registry, env: (target) => new NodeExecutionEnv({ cwd: target.cwd ?? process.cwd() }) },
	context,
);
const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: directory } });

// 每次工具调用都会作为由本轮生成任务拥有的持久化 pi.tool 任务运行。生成任务会等待这些工具任务完成，
// 然后继续下一轮生成。
const settled = await (await root.submit({ type: "input", content: "Greet durable instead." }, context)).wait(context);
console.log("status:", settled.status);
const transcript = await root.entries({}, 20, undefined, context);
for (const entry of [...transcript.items].reverse()) {
	if (!ToolResultEntry.is(entry)) {
		console.log(entry.kind);
		continue;
	}
	const result = entry.model![0] as ToolResultMessage;
	const text = result.content.map((item) => (item.type === "text" ? item.text : "")).join("");
	console.log(
		`${entry.kind} ${result.toolName}:`,
		JSON.stringify(text.length > 200 ? `${text.slice(0, 200)}…` : text),
	);
}
if (settled.status === "done" && settled.type === "input") {
	const answer = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
	const message = answer?.model?.[0];
	console.log("answer:", message?.role === "assistant" ? message.content : message);
}
console.log("file:", JSON.stringify(await readFile(join(directory, "notes.txt"), "utf8")));
await harness.close(context);
console.log("storage:", directory);
