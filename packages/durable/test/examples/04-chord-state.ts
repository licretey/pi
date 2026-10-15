// 通过 Chord 暴露文档。
// 在 packages/durable 目录下运行：
//   node --conditions=source --experimental-strip-types test/examples/04-chord-state.ts
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
const chat = await session.commit(async (tx) => {
	const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
	(await tx.doc(Notes, conversation.id)).text = "first";
	return conversation;
}, context);

// documentState() 不会创建文档。它会返回已加载的只读
// Chord 状态绑定到当前具体实例。
const notesState = await session.documentState(Notes, chat.id, context);
if (notesState === undefined) throw new Error("notes are absent");
const stopNotes = notesState.subscribe((value, _deliveryContext, delivery) => {
	console.log("Chord notes:", delivery.kind, delivery.sequence, value);
});
await session.commit(async (tx) => {
	(await tx.doc(Notes, chat.id)).text = "published through Chord";
}, context);
stopNotes();
notesState.dispose();

await session.close(context);
