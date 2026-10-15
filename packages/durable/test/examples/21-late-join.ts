// 中途加入：运行已经开始后客户端才连接。客户端会先获取当前状态，对话
// 视图或快照事件，然后只接收此后发生的变更。
// 在 packages/durable 目录下运行：
//   node --conditions=source --experimental-strip-types test/examples/21-late-join.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	type AgentEvent,
	createRegistry,
	defineExtension,
	defineTool,
	Harness,
	type LiveState,
	MemoryStorage,
	watchEvents,
} from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// 工具每 100 毫秒输出一行，随后模型缓慢流式返回回答。
const registry = createRegistry();
registry.install(
	defineExtension({
		name: "count",
		tools: [
			defineTool({
				name: "count",
				description: "Counts to ten",
				parameters: Type.Object({}),
				execute: async (_args, api) => {
					for (let n = 1; n <= 10; n++) {
						api.output(`${n}\n`);
						await pause(100);
					}
					return {};
				},
			}),
		],
	}),
);
const faux = fauxProvider({ tokensPerSecond: 40, tokenSize: { min: 1, max: 1 } });
faux.setResponses([
	fauxAssistantMessage([fauxToolCall("count", {}, { id: "call-1" })], { stopReason: "toolUse" }),
	fauxAssistantMessage([fauxText("Counted to ten, and this answer streams slowly.")]),
]);
const models = createModels();
models.setProvider(faux.provider);
const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });

const submission = await root.submit({ type: "input", content: "Count to ten, then tell me." }, context);
// 在工具执行到一半时加入。
await pause(500);

// 结构化客户端：视图保存已提交的对话记录和文档，包括正在运行的工具输出。
const view = await root.viewState(context);
const live = view.value.docs["pi.live"] as LiveState;
console.log(
	"view entries:",
	view.value.entries.map((entry) => entry.kind),
);
console.log("view tool slot:", live.tools?.[0]?.status, JSON.stringify(live.tools?.[0]?.output));
view.subscribe((value) => {
	const slot = (value.docs["pi.live"] as LiveState).tools?.[0];
	if (slot?.status === "running") console.log("view output now:", JSON.stringify(slot.output));
});

// 事件客户端：快照事件携带相同状态，后续事件会在此状态基础上应用。
const stream = await watchEvents(harness, root.id, context);
console.log(
	"snapshot tools:",
	stream.snapshot.tools.map((slot) => `${slot.name} ${slot.status}`),
);
let output = stream.snapshot.tools[0]?.output ?? "";
stream.start(async (events: readonly AgentEvent[]) => {
	for (const event of events) {
		if (event.type === "tool_execution_update" && event.output !== undefined) {
			output =
				"set" in event.output
					? event.output.set
					: output.slice(event.output.trimStart ?? 0) + (event.output.append ?? "");
			console.log("event output now:", JSON.stringify(output));
		} else if (event.type === "message_update") {
			const deltas = event.changes.flatMap((change) => (change.type === "text_delta" ? [change.delta] : []));
			console.log("event text delta:", JSON.stringify(deltas.join("")));
		} else {
			console.log("event:", event.type);
		}
	}
});

await submission.wait(context);
await harness.waitForIdle(context);
await pause(0);
await stream.stop();
view.dispose();
await harness.close(context);
