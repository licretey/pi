// 演示 Models API 实际用法的临时脚本。
// 在 packages/ai 目录下运行：node test/scratch.ts
// 需要设置 ANTHROPIC_API_KEY。

import { createModels } from "../src/models.ts";
import { anthropicProvider } from "../src/providers/anthropic.ts";
import type { Context } from "../src/types.ts";

// ---------------------------------------------------------------------------
// 1. 创建 Models 运行时，并注册一个内置提供商工厂。
//    （需要加载全部内置提供商的应用可使用 providers/all 中的 `builtinModels()`。）
// ---------------------------------------------------------------------------

const models = createModels();
models.setProvider(anthropicProvider());

// ---------------------------------------------------------------------------
// 2. 查找模型并检查认证配置。
// ---------------------------------------------------------------------------

const model = models.getModel("anthropic", "claude-haiku-4-5");
if (!model) throw new Error("model not found");

const auth = await models.getAuth(model.provider);
console.log(`model: ${model.provider}/${model.id}`);
console.log(`auth:  ${auth ? `configured via ${auth.source}` : "not configured"}\n`);
if (!auth) process.exit(1);

const context: Context = {
	systemPrompt: "You are terse.",
	messages: [{ role: "user", content: "Say exactly: ok", timestamp: Date.now() }],
};

// ---------------------------------------------------------------------------
// 3. 执行简单补全（请求级认证会在内部解析）。
// ---------------------------------------------------------------------------

const message = await models.completeSimple(model, context);
console.log(`completeSimple -> [${message.stopReason}]`, message.content);

// ---------------------------------------------------------------------------
// 4. 通过增量事件接收流式响应。
// ---------------------------------------------------------------------------

context.messages.push(message, {
	role: "user",
	content: "Now count from 1 to 5, one number per line.",
	timestamp: Date.now(),
});

process.stdout.write("streamSimple   -> ");
const stream = models.streamSimple(model, context);
for await (const event of stream) {
	if (event.type === "text_delta") process.stdout.write(event.delta.replaceAll("\n", " "));
}
const final = await stream.result();
console.log(`[${final.stopReason}] cost: $${final.usage.cost.total.toFixed(6)}`);
