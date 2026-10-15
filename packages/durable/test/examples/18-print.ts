// 打印模式：提交一条提示并打印回答，类似 `pi -p`。宿主等待自己提交的 Submission，而不是等待全局
// 空闲状态。设置 OPENAI_API_KEY 时使用 OpenAI，否则使用脚本化的 faux 模型。
// 在 packages/durable 目录下运行：
//   node --conditions=source --experimental-strip-types test/examples/18-print.ts "What is in this directory?"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { NodeExecutionEnv } from "../../src/env/node.ts";
import { AssistantEntry, createRegistry, defineExtension, Harness, MemoryStorage, section } from "../../src/index.ts";
import { createBashTool, createReadTool } from "../../src/tools/index.ts";

const context = BACKGROUND_CONTEXT;
const prompt = process.argv[2] ?? "What is in this directory?";

const models = createModels();
let model = { provider: "openai", modelId: "gpt-6-sol" };
if (process.env.OPENAI_API_KEY !== undefined) {
	models.setProvider(openaiProvider());
} else {
	const faux = fauxProvider();
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
const harness = await Harness.open(new MemoryStorage(), { models, registry, env: () => env }, context);
const root = await harness.root(context, { agent: { model } });

const submission = await root.submit({ type: "input", content: prompt }, context);
const settled = await submission.wait(context);
if (settled.status === "done" && settled.type === "input") {
	const entry = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
	const answer = entry?.model?.[0] as AssistantMessage;
	console.log(answer.content.flatMap((content) => (content.type === "text" ? [content.text] : [])).join(""));
} else {
	console.error(`unanswered: ${settled.status === "unanswered" ? settled.reason : settled.status}`);
	process.exitCode = 1;
}
await harness.close(context);
