// JSON 模式：像 `pi --mode json` 一样，以 JSON 行流式输出一次提示词运行过程。支持两种模式：
//   --events（默认）：watchEvents() 提供的实验性代理事件流，以 `snapshot` 事件开头。
//   --ops：原始 ConversationView 帧，先输出视图本身，之后每行包含一次提交的操作。
// --storage sqlite（默认）| jsonl | memory：sqlite 会写入临时数据库文件，jsonl 会写入临时目录；
// 两者都不会删除，程序结束时会将路径输出到标准错误。
// 设置 OPENAI_API_KEY 时使用 OpenAI，否则使用脚本控制的模拟模型。
// 在 packages/durable 目录下运行：
//   node --conditions=source --experimental-strip-types test/examples/19-json.ts --events "What is in this directory?"
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { NodeExecutionEnv } from "../../src/env/node.ts";
import {
	createRegistry,
	defineExtension,
	Harness,
	MemoryStorage,
	type Storage,
	section,
	watchEvents,
} from "../../src/index.ts";
import { openNodeJsonlStorage } from "../../src/storage/jsonl/node.ts";
import { openNodeSqliteStorage } from "../../src/storage/sqlite/node.ts";
import { createBashTool, createReadTool } from "../../src/tools/index.ts";

const context = BACKGROUND_CONTEXT;
const args = process.argv.slice(2);
const mode = args.includes("--ops") ? "ops" : "events";
const storageIndex = args.indexOf("--storage");
const storageKind = storageIndex < 0 ? "sqlite" : args[storageIndex + 1];
const prompt =
	args.find((arg, index) => !arg.startsWith("--") && (storageIndex < 0 || index !== storageIndex + 1)) ??
	"What is in this directory?";

let storage: Storage;
let location: string | undefined;
if (storageKind === "sqlite") {
	location = join(tmpdir(), `pi-durable-json-${Date.now()}.sqlite`);
	storage = await openNodeSqliteStorage(location);
} else if (storageKind === "jsonl") {
	location = await mkdtemp(join(tmpdir(), "pi-durable-json-"));
	storage = await openNodeJsonlStorage(location, context);
} else if (storageKind === "memory") {
	storage = new MemoryStorage();
} else {
	throw new Error(`Unknown --storage ${storageKind}; use sqlite, jsonl, or memory`);
}
const print = (value: unknown): void => void process.stdout.write(`${JSON.stringify(value)}\n`);

const models = createModels();
let model = { provider: "openai", modelId: "gpt-6-sol" };
if (process.env.OPENAI_API_KEY !== undefined) {
	models.setProvider(openaiProvider());
} else {
	const faux = fauxProvider({ tokensPerSecond: 200 });
	models.setProvider(faux.provider);
	model = { provider: "faux", modelId: "faux-1" };
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("bash", { command: "ls" }, { id: "call-1" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("This directory holds the durable package sources, tests, and docs.")]),
	]);
}

const registry = createRegistry();
registry.install(
	defineExtension({
		name: "coding",
		tools: [createReadTool(), createBashTool()],
		sections: [section("preamble", () => "You are a concise coding assistant.", { tag: false })],
	}),
);
const env = new NodeExecutionEnv({ cwd: process.cwd() });
const harness = await Harness.open(storage, { models, registry, env: () => env }, context);
const root = await harness.root(context, { agent: { model } });

// 在提交输入前建立监听，以便流涵盖整个运行过程。
let stop: () => Promise<unknown>;
if (mode === "events") {
	const stream = await watchEvents(harness, root.id, context);
	print(stream.snapshot);
	stream.start(async (events) => {
		for (const event of events) print(event);
	});
	stop = () => stream.stop();
} else {
	const watch = await root.watch(context);
	print({ view: watch.value });
	watch.start(async (_value, ops) => print({ ops }));
	stop = () => watch.stop();
}

const submission = await root.submit({ type: "input", content: prompt }, context);
await submission.wait(context);
await harness.waitForIdle(context);
// 等待最后一批事件送达监听器后再停止。
await new Promise((resolve) => setTimeout(resolve, 0));
await stop();
await harness.close(context);
if (location !== undefined) console.error(`${storageKind} storage: ${location}`);
