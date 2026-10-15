// 为对话创建分支。
// 在 packages/durable 目录下运行：
//   node --conditions=source --experimental-strip-types test/examples/02-forks.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createSession, defineDoc, MemoryStorage } from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;
const session = createSession(new MemoryStorage());

const Notes = defineDoc<{ text: string }>({
	kind: "example.notes",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ text: "" }),
});

const chat = await session.commit((tx) => tx.createConversation({ ownership: { kind: "ownerless" } }), context);
const firstEntry = await session.commit(async (tx) => {
	const entry = await tx.appendEntry(chat.id, { kind: "note", data: "hello" });
	(await tx.doc(Notes, chat.id)).text = "after hello";
	return entry;
}, context);
await session.commit(async (tx) => {
	await tx.appendEntry(chat.id, { kind: "note", data: "goodbye" });
	(await tx.doc(Notes, chat.id)).text = "after goodbye";
}, context);

// 分支是一个从另一个对话的指定条目继续的新对话。它可以看到父对话截至该条目的记录，
// 每份文档则遵循自己的 `fork` 设置。Notes 使用 "asOf"，因此分支会从分支条目对应的笔记值开始。
const branch = await session.commit(
	(tx) => tx.forkConversation(chat.id, firstEntry.id, { ownership: { kind: "ownerless" } }),
	context,
);

// scanEntries() 会分页读取可见条目，并按时间倒序排列。分支能看到从父对话继承的 "hello"，
// 但看不到之后才添加的 "goodbye"。
const branchEntries = await session.commit((tx) => tx.scanEntries({ conversationId: branch.id }, 10), context);
console.log(
	"fork transcript:",
	branchEntries.items.map((entry) => entry.data),
);
console.log("fork notes:", await session.snapshot(Notes, branch.id, context));

// 分支中的副本相互独立：修改分支不会影响父对话。
await session.commit(async (tx) => {
	(await tx.doc(Notes, branch.id)).text = "changed only in the fork";
}, context);
console.log("fork notes after edit:", await session.snapshot(Notes, branch.id, context));
console.log("parent notes after edit:", await session.snapshot(Notes, chat.id, context));

await session.close(context);
