// 每个对话使用独立沙箱：应用将沙箱信息记录在对话自己的文档中，Harness 的环境函数会在每次工具调用时查询该文档。
// 此处使用目录作为沙箱；托管产品则可以返回在对话容器中运行的 ExecutionEnv。
// 在 packages/durable 目录下运行：
//   node --conditions=source --experimental-strip-types test/examples/29-sandbox-per-conversation.ts
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { NodeExecutionEnv } from "../../src/env/node.ts";
import { createRegistry, defineDoc, Harness, MemoryStorage } from "../../src/index.ts";
import { CodingTools } from "../../src/tools/index.ts";

const context = BACKGROUND_CONTEXT;

// 指定对话使用的沙箱。`fork: "initial"` 表示分支在应用为其分配沙箱前不使用任何沙箱。
const Sandbox = defineDoc<{ path?: string }>({
	kind: "app.sandbox",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({}),
});

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const note = (text: string) =>
	fauxAssistantMessage(fauxToolCall("write", { path: "note.txt", content: text }), { stopReason: "toolUse" });
faux.setResponses([
	note("from alice"),
	fauxAssistantMessage("Saved."),
	note("from bob"),
	fauxAssistantMessage("Saved."),
]);

const registry = createRegistry();
registry.install(CodingTools);
const harness = await Harness.open(
	new MemoryStorage(),
	{
		models,
		registry,
		// 只读取已提交的数据；未分配沙箱的对话不会获得执行环境，因此其工具会以可控方式失败。
		env: async ({ conversationId, read }, envContext) => {
			const sandbox = await read.snapshot(Sandbox, conversationId, envContext);
			return sandbox?.path === undefined ? undefined : new NodeExecutionEnv({ cwd: sandbox.path });
		},
	},
	context,
);

// 为每位用户创建的对话都会在创建事务中分配一个全新的沙箱。
const model = { provider: "faux", modelId: "faux-1" };
async function conversationFor(user: string) {
	const path = await mkdtemp(join(tmpdir(), `pi-durable-sandbox-${user}-`));
	const conversation = await harness.createConversation(
		{
			ownership: { kind: "ownerless" },
			agent: { model },
			init: async (tx, id) => {
				(await tx.doc(Sandbox, id)).path = path;
			},
		},
		context,
	);
	return { conversation, path };
}

const alice = await conversationFor("alice");
const bob = await conversationFor("bob");
await (await alice.conversation.submit({ type: "input", content: "Leave a note." }, context)).wait(context);
await (await bob.conversation.submit({ type: "input", content: "Leave a note." }, context)).wait(context);
console.log("alice's sandbox:", await readFile(join(alice.path, "note.txt"), "utf8"));
console.log("bob's sandbox:", await readFile(join(bob.path, "note.txt"), "utf8"));

await harness.close(context);
await rm(alice.path, { recursive: true, force: true });
await rm(bob.path, { recursive: true, force: true });
