// 为部分会话替换工具，并装饰最终生效的工具：让 bash 在 Python 虚拟环境中运行，
// 再通过包装器统计每次 bash 调用的耗时。
// 在 packages/durable 目录下运行：
//   node --conditions=source --experimental-strip-types test/examples/30-tool-override.ts
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { NodeExecutionEnv } from "../../src/env/node.ts";
import {
	type Conversation,
	createRegistry,
	defineExtension,
	Harness,
	MemoryStorage,
	ToolResultEntry,
	wrapTool,
} from "../../src/index.ts";
import { CodingTools, createBashTool } from "../../src/tools/index.ts";

const context = BACKGROUND_CONTEXT;

// ─── 产品代码 ───────────────────────────────────────────────────────────────

// 注册同名的 bash：若在 CodingTools 之后选中此工具，它会就地替换 CodingTools 中的 bash。
const Venv = defineExtension({
	name: "venv",
	tools: [createBashTool({ commandPrefix: "source .venv/bin/activate" })],
});

// 包装最终生效的 bash，无论它来自哪里。包装器不会捕获基础工具，因此任一 bash 重新加载后包装仍然有效。
const timings: number[] = [];
const Timing = defineExtension({
	name: "timing",
	wraps: [
		wrapTool(createBashTool(), (bash) => ({
			...bash,
			execute: async (args, api, callContext) => {
				const start = Date.now();
				try {
					return await bash.execute(args, api, callContext);
				} finally {
					timings.push(Date.now() - start);
				}
			},
		})),
	],
});

// ─── 宿主环境设置 ───────────────────────────────────────────────────────────

const project = await mkdtemp(join(tmpdir(), "pi-durable-venv-"));
await mkdir(join(project, ".venv/bin"), { recursive: true });
await writeFile(join(project, ".venv/bin/activate"), `export VIRTUAL_ENV="${project}/.venv"\n`);

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const probe = () =>
	fauxAssistantMessage(fauxToolCall("bash", { command: "echo venv: $VIRTUAL_ENV" }), {
		stopReason: "toolUse",
	});
faux.setResponses([probe(), fauxAssistantMessage("Done."), probe(), fauxAssistantMessage("Done.")]);

const registry = createRegistry();
registry.install(CodingTools);
registry.install(Timing);
registry.install(Venv);
const harness = await Harness.open(
	new MemoryStorage(),
	{
		models,
		registry,
		// 已安装 Venv，但默认不选择它。
		settings: { extensions: [CodingTools, Timing] },
		env: () => new NodeExecutionEnv({ cwd: project }),
	},
	context,
);
const model = { provider: "faux", modelId: "faux-1" };
const plain = await harness.root(context, { agent: { model } });
const python = await harness.createConversation(
	{ ownership: { kind: "ownerless" }, agent: { model, extensions: { add: [Venv] } } },
	context,
);

async function probeBash(conversation: Conversation): Promise<string> {
	await (await conversation.submit({ type: "input", content: "Which venv?" }, context)).wait(context);
	const page = await conversation.entries({}, 10, undefined, context);
	const result = page.items.find((entry) => ToolResultEntry.is(entry))?.model?.[0] as ToolResultMessage;
	return result.content.map((part) => (part.type === "text" ? part.text.trim() : "")).join("");
}

console.log("plain conversation:", await probeBash(plain));
console.log("python conversation:", (await probeBash(python)).replace(project, "<project>"));
console.log("timed bash calls:", timings.length);

await harness.close(context);
await rm(project, { recursive: true, force: true });
