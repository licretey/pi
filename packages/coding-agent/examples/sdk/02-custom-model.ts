/**
 * 自定义模型选择。
 *
 * 演示如何选择指定模型和思考级别。
 */

import { createAgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";

const modelRuntime = await ModelRuntime.create();

// 方式一：按提供方和 ID 查找指定的内置模型。
const opus = modelRuntime.getModel("anthropic", "claude-opus-4-5");
if (opus) {
	console.log(`Found model: ${opus.provider}/${opus.id}`);
}

// 方式二：通过注册表查找模型（包括 models.json 中定义的自定义模型）。
const customModel = modelRuntime.getModel("my-provider", "my-model");
if (customModel) {
	console.log(`Found custom model: ${customModel.provider}/${customModel.id}`);
}

// 方式三：从可用模型中选择（这些模型已有有效的 API 密钥）。
const available = await modelRuntime.getAvailable();
console.log(
	"Available models:",
	available.map((m) => `${m.provider}/${m.id}`),
);

if (available.length > 0) {
	const { session } = await createAgentSession({
		model: available[0],
		thinkingLevel: "medium", // off, low, medium, high
		modelRuntime,
	});

	try {
		session.subscribe((event) => {
			if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
				process.stdout.write(event.assistantMessageEvent.delta);
			}
		});

		await session.prompt("Say hello in one sentence.");
		console.log();
	} finally {
		session.dispose();
	}
}
