// Session 用于保存对话、记录条目、任务和文档。
// 在 packages/durable 目录下运行：
//   node --conditions=source --experimental-strip-types test/examples/00-conversation.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createSession, MemoryStorage } from "../../src/index.ts";

// MemoryStorage 将所有数据保存在内存中；其他存储后端会将数据保存到磁盘。
const session = createSession(new MemoryStorage());

// 每次调用 Session 都需要传入 context，用于取消操作。
// BACKGROUND_CONTEXT 表示“永不取消”。
const context = BACKGROUND_CONTEXT;

// 所有写入都在 session.commit() 中执行。回调会收到事务 `tx`；回调返回时，其中的所有写入会一并保存，
// 若回调抛出异常，则所有写入都会被丢弃。
// "ownerless" 表示此对话并非由任务创建。
const standalone = await session.commit((tx) => tx.createConversation({ ownership: { kind: "ownerless" } }), context);
console.log("standalone conversation:", standalone);

await session.close(context);
