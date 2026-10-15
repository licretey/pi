import { Client } from "@earendil-works/pi-client";
import { createAssistantMessageEventStream, Type } from "@earendil-works/pi-ai";
import { complete, getModel, getProviders, streamSimple } from "@earendil-works/pi-ai/compat";
import { Agent, streamProxy } from "@earendil-works/pi-agent-core";
import { decodeCbor, encodeCbor, PROTOCOL_VERSION } from "@earendil-works/pi-protocol";

// 确保此入口可在浏览器中运行。scripts/check-browser-smoke.mjs 会打包它，
// 用于发现面向浏览器的包导出中误导入 Node 专用运行时模块的情况。
const model = getModel("google", "gemini-2.5-flash");
const schema = Type.Object({ prompt: Type.String() });
const stream = createAssistantMessageEventStream();

const agent = new Agent({ initialState: { model }, streamFn: streamSimple });
agent.steer({ role: "user", content: [{ type: "text", text: "queued" }], timestamp: 0 });

console.log(
	model.id,
	getProviders().length,
	typeof complete,
	schema.type,
	typeof stream.push,
	agent.hasQueuedMessages(),
	typeof streamProxy,
	typeof Client,
	PROTOCOL_VERSION,
	decodeCbor(encodeCbor({ browser: true })),
);
