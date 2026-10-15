// 将文档状态与对话记录条目一同保存。
// 在 packages/durable 目录下运行：
//   node --conditions=source --experimental-strip-types test/examples/01-documents.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createSession, defineDoc, MemoryStorage } from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;
const session = createSession(new MemoryStorage());

// 文档是附加到某个对象上的 JSON 对象；此处每个对话各有一个文档。
// "rewindable" 会保留旧值，因此可以查询写入特定条目时的文档内容。
// `fork` 用于指定对话分支副本的初始内容（参见 02-forks.ts）。
const Notes = defineDoc<{ text: string }>({
	kind: "example.notes",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf", // 分支从创建分支的条目对应时刻开始，使用当时的笔记值。
	initial: () => ({ text: "" }),
});

const chat = await session.commit((tx) => tx.createConversation({ ownership: { kind: "ownerless" } }), context);

// tx.doc() 返回可编辑的文档副本（首次使用时创建）。
// 对副本直接赋值的更改会在事务提交时保存。
const firstEntry = await session.commit(async (tx) => {
	const entry = await tx.appendEntry(chat.id, { kind: "note", data: "hello" });
	(await tx.doc(Notes, chat.id)).text = "after hello";
	return entry;
}, context);

const secondEntry = await session.commit(async (tx) => {
	const entry = await tx.appendEntry(chat.id, { kind: "note", data: "goodbye" });
	(await tx.doc(Notes, chat.id)).text = "after goodbye";
	return entry;
}, context);

// snapshot() 读取最新值。snapshotAsOf() 读取与指定条目在同一事务中保存的值。
console.log("latest notes:", await session.snapshot(Notes, chat.id, context));
console.log("notes at first entry:", await session.snapshotAsOf(Notes, chat.id, firstEntry.id, context));
console.log("notes at second entry:", await session.snapshotAsOf(Notes, chat.id, secondEntry.id, context));

await session.close(context);
