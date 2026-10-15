// 使用真实模型：从 OpenAI 流式获取回答。
// 在 packages/durable 目录下运行（需要 OPENAI_API_KEY）：
//   node --conditions=source --experimental-strip-types test/examples/16-real-model.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import {
	AssistantEntry,
	createRegistry,
	defineExtension,
	Harness,
	LiveDoc,
	MemoryStorage,
	section,
} from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;

// 生产代码会传入包含真实提供商的 Models 集合；Harness
// 不会通过其他途径调用提供方。openaiProvider() 会从环境变量读取
// OPENAI_API_KEY。回答流式生成期间，generation 会限速提交部分内容到对话的
// pi.live 文档。监听
// 该文档会流式传输回答；watch 只会看到已提交的值。
if (process.env.OPENAI_API_KEY === undefined) {
	console.log("skipped: OPENAI_API_KEY is not set");
} else {
	const models = createModels();
	models.setProvider(openaiProvider());
	const registry = createRegistry();
	registry.install(
		defineExtension({
			name: "concise",
			sections: [section("preamble", () => "You are a concise assistant.", { tag: false })],
		}),
	);
	const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
	const root = await harness.root(context, {
		agent: { model: { provider: "openai", modelId: "gpt-6-sol" }, thinkingLevel: "high" },
	});
	const liveWatch = (await harness.watchDoc(LiveDoc, root.id, context))!;
	// 只输出每个已提交的部分相较于已有文本新增的内容。
	let printed = "";
	const printText = (text: string): void => {
		if (text.length <= printed.length || !text.startsWith(printed)) return;
		process.stdout.write(text.slice(printed.length));
		printed = text;
	};
	liveWatch.start(async (value) => {
		const block = value?.generation?.message?.content.find((content) => content.type === "text");
		if (block?.type === "text") printText(block.text);
	});
	harness.resume();
	process.stdout.write("answer: ");
	const poem = await root.submit({ type: "input", content: "Write a long poem" }, context);
	const settledPoem = await poem.wait(context);
	await liveWatch.stop();
	if (settledPoem.status === "done" && settledPoem.type === "input") {
		// 最后一个节流窗口可能尚未作为部分内容提交；其余内容会包含在回答条目中。
		const entry = await root.commit((tx) => tx.entry(AssistantEntry, settledPoem.answer), context);
		const message = entry?.model?.[0];
		const block =
			message?.role === "assistant" ? message.content.find((content) => content.type === "text") : undefined;
		if (block?.type === "text") printText(block.text);
		process.stdout.write("\n");
	} else {
		console.log("unanswered:", settledPoem.reason, settledPoem.detail);
	}
	await harness.close(context);
}
