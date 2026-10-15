// 拥有子对话的后台任务。
// 在 packages/durable 目录下运行：
//   node --conditions=source --experimental-strip-types test/examples/03-owned-conversations.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ConversationId, createSession, defineDoc, defineTask, MemoryStorage } from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;
const session = createSession(new MemoryStorage());

// 一种常见的代理配置：后台任务负责监督辅助对话，主对话保存代理名称到其对话的映射表。
// 三者在同一事务中创建，因此即使发生崩溃，也会全部存在或全部不存在。

// 任务定义需要包含名称、版本、初始状态、每个阶段的处理器和中止处理器（12-tasks.ts 会运行任务）。
// 此示例只创建任务记录；普通 Session 不会运行任务。
const Supervisor = defineTask<null, { phase: "ready" }, null>({
	name: "example.supervisor",
	version: 1,
	initial: () => ({ phase: "ready" }),
	phases: { ready: async () => {} },
	abort: async () => {},
});

// "latest" 只保留当前值。"initial" 表示此对话的分支从空注册表开始，
// 因此子对话不会继承父对话的代理列表。
const AgentRegistry = defineDoc<{
	agents: Record<string, { conversationId: ConversationId; requestId: string }>;
}>({
	kind: "example.agent-registry",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ agents: {} }),
});

const main = await session.commit((tx) => tx.createConversation({ ownership: { kind: "ownerless" } }), context);

const setup = await session.commit(async (tx) => {
	// `background: true` 表示这是后台工作：等待主对话完成时，不必等待此任务。
	const supervisorId = await tx.createTask(Supervisor, null, {
		ownership: { kind: "conversation" },
		conversationId: main.id,
		background: true,
	});

	// 子对话会记录自己归属于监督任务。该任务在同一事务中创建，因此可以这样引用。
	const child = await tx.createConversation({ ownership: { kind: "task", taskId: supervisorId } });

	// requestId 是子对话首条消息的固定名称。后续代码使用此 ID 发送消息，
	// 这样崩溃后重试时就不会重复发送。
	(await tx.doc(AgentRegistry, main.id)).agents.researcher = {
		conversationId: child.id,
		requestId: `researcher:first-message:${supervisorId}`,
	};
	return { supervisorId, child };
}, context);

console.log("supervisor task:", setup.supervisorId);
console.log("child conversation:", setup.child);
console.log("registry:", await session.snapshot(AgentRegistry, main.id, context));

await session.close(context);
