// 系统提示词分节和各对话的指令。
// 在 packages/durable 目录下运行：
//   node --conditions=source --experimental-strip-types test/examples/15-system-prompt.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { NodeExecutionEnv } from "../../src/env/node.ts";
import {
	type Conversation,
	createRegistry,
	defineExtension,
	Harness,
	MemoryStorage,
	SystemEntry,
	section,
	wrapSection,
} from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([fauxAssistantMessage("Done."), fauxAssistantMessage("Done."), fauxAssistantMessage("Done.")]);

// Pico 不会保存提示词状态。每次模型请求前，系统会渲染该对话所选扩展的各个分节，
// 并只将与模型已看到内容之间的差异作为 `pi.system` 条目追加到对话记录中。
const Coding = defineExtension({
	name: "coding",
	sections: [
		// `tag: false` 表示原样发送文本；默认情况下会用 <key>...</key> 包裹。
		section("preamble", () => "You are a coding agent.", { tag: false }),
		// 分节可以访问为此请求创建的环境，此处用于获取工作目录。
		section("cwd", (input) => input.env?.cwd),
	],
});
const AgentsMd = defineExtension({
	name: "agents-md",
	sections: [section("agents_md", () => "Run npm run check after changes.")],
});
// 另一个扩展按键名装饰现有分节，而不会替换它。
const Terse = defineExtension({
	name: "terse",
	wraps: [
		wrapSection("preamble", (preamble) => ({
			...preamble,
			render: async (input, renderContext) => `${await preamble.render(input, renderContext)} Be terse.`,
		})),
	],
});

const registry = createRegistry();
registry.install(Coding);
registry.install(AgentsMd);
registry.install(Terse);
// 执行环境会使用每个对话代理的 `cwd`。
const env = ({ cwd = "/" }: { readonly cwd?: string }) => new NodeExecutionEnv({ cwd });
const harness = await Harness.open(new MemoryStorage(), { models, registry, env }, context);
const model = { provider: "faux", modelId: "faux-1" };
const root = await harness.root(context, { agent: { model, cwd: "/repo" } });

// 子代理取消选择 AGENTS.md，并使用自己的指令；该指令最后作为 `instructions` 分节渲染。
const subagent = await harness.createConversation(
	{
		ownership: { kind: "ownerless" },
		agent: {
			model,
			cwd: "/repo",
			extensions: { remove: [AgentsMd] },
			instructions: "Only read; never edit files.",
		},
	},
	context,
);

async function systemEntries(conversation: Conversation) {
	const page = await conversation.entries({}, 20, undefined, context);
	return [...page.items].reverse().flatMap((entry) => (SystemEntry.is(entry) ? (entry.model ?? []) : []));
}

await (await root.submit({ type: "input", content: "Fix the build." }, context)).wait(context);
await (await subagent.submit({ type: "input", content: "Read the logs." }, context)).wait(context);
console.log("root system prompt:", await systemEntries(root));
console.log("subagent system prompt:", await systemEntries(subagent));

// 分节输出发生变化时，下一次请求只会追加变化部分。
await root.configure({ cwd: "/repo/packages" }, context);
await (await root.submit({ type: "input", content: "Now the package." }, context)).wait(context);
console.log("root system entries after cwd change:", await systemEntries(root));

await harness.close(context);
