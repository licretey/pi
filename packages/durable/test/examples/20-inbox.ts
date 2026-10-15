// 收件箱：对话忙碌时提交的输入会如何处理。
// 在 packages/durable 目录下运行：
//   node --conditions=source --experimental-strip-types test/examples/20-inbox.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, InboxDoc, MemoryStorage, type Submission } from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;

// 首个回答会一直等待，直到我们放行；因此提交更多内容时，对话仍处于忙碌状态。
let release!: () => void;
const held = new Promise<void>((resolve) => {
	release = resolve;
});
const slow: FauxResponseStep = async () => {
	await held;
	return fauxAssistantMessage("Answer to the first question.");
};
const faux = fauxProvider();
faux.setResponses([slow, fauxAssistantMessage("Answer to the follow-up and the steer.")]);
const models = createModels();
models.setProvider(faux.provider);

// 设置适用于所有会话：每次运行结束时一次性放置所有排队的 follow-up，而不是每轮只放置一个。
const harness = await Harness.open(
	new MemoryStorage(),
	{ models, registry: createRegistry(), settings: { followUpMode: "all" } },
	context,
);
const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });

const first = await root.submit({ type: "input", content: "First question" }, context);

// 会话忙碌时，输入会作为 follow-up（默认）或 steer 排队，写入操作也会排队。
const followUp = await root.submit({ type: "input", content: "A follow-up" }, context);
const steer = await root.submit({ type: "input", content: "A steer", whenBusy: "steer" }, context);
const note = await root.submit({ type: "write", entry: { kind: "app.note", data: "noted while busy" } }, context);
const withdrawn = await root.submit({ type: "input", content: "Never mind" }, context);
// whenBusy: "reject" 会直接拒绝提交，而不是将其排入队列。
await root.submit({ type: "input", content: "Now or never", whenBusy: "reject" }, context).catch((error: Error) => {
	console.log("rejected:", error.message);
});
// 排队中的提交可以在边界将其放入对话前撤回。
console.log("withdraw:", await withdrawn.abort(context));

const inbox = await harness.snapshot(InboxDoc, root.id, context);
console.log(
	"inbox:",
	inbox?.items.map((item) => `${item.id} ${item.mode}`),
);

// 首个回答会在最终边界结束本次运行：先放置写入，再放置 steer 和 follow-up，并由它们共同开启下一次运行。
release();
const status = async (name: string, submission: Submission) => {
	const record = await submission.wait(context);
	console.log(`${name}:`, record.status, record.status === "unanswered" ? record.reason : "");
};
await status("first", first);
await status("follow-up", followUp);
await status("steer", steer);
await status("note", note);
await status("withdrawn", withdrawn);

const page = await root.entries({}, 20, undefined, context);
console.log(
	"transcript:",
	[...page.items].reverse().map((entry) => entry.kind),
);
await harness.close(context);
