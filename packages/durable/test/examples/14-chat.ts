// 一轮对话。
// 在 packages/durable 目录下运行：
//   node --conditions=source --experimental-strip-types test/examples/14-chat.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { AssistantEntry, createRegistry, defineExtension, Harness, MemoryStorage, section } from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;

// 使用模拟提供商代替真实模型（参见 16-real-model.ts）。
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([fauxAssistantMessage("Paris.")]);

const registry = createRegistry();
registry.install(
	defineExtension({
		name: "terse",
		sections: [section("preamble", () => "You answer in one word.", { tag: false })],
	}),
);
const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });

// submit() 会持久化接纳用户输入并返回 Submission。内置的
// pi.generation 任务会根据智能体的区段构造系统提示词、调用模型并追加回答；
// 输入得到回答或处理失败后，wait() 才会兑现。
const capital = await root.submit({ type: "input", content: "Capital of France?" }, context);
const answered = await capital.wait(context);
if (answered.status === "done" && answered.type === "input") {
	const entry = await root.commit((tx) => tx.entry(AssistantEntry, answered.answer), context);
	const reply = entry?.model?.[0];
	console.log("answer:", reply?.role === "assistant" ? reply.content : reply);
}

// 对话记录包含用户输入、按位置记录的系统提示词和回答。
const transcript = await root.entries({}, 10, undefined, context);
console.log(
	"transcript:",
	[...transcript.items].reverse().map((entry) => entry.kind),
);
await harness.close(context);
