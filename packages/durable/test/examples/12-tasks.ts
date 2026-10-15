// 运行一个持久化任务。
// 在 packages/durable 目录下运行：
//   node --conditions=source --experimental-strip-types test/examples/12-tasks.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineExtension, defineTask, Harness, MemoryStorage } from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;

// 任务是一个小型状态机，其状态（即检查点）会在每一步保存，因此崩溃后重新打开时会从最近保存的步骤继续。
// 常见模式是：先保存即将执行的操作，再执行操作，最后保存结果。如果在执行后、保存前崩溃，
// 该步骤会重跑，因此必须允许重复执行；
// 本例中的模拟支付服务会忽略重复的键。
const payments = new Map<string, number>();
type PaymentState = { phase: "prepare" } | { phase: "charge"; key: string };
const Payment = defineTask<{ amount: number }, PaymentState, { receipt: number }>({
	name: "example.payment",
	version: 1,
	initial: () => ({ phase: "prepare" }),
	// 每个阶段对应一个处理器。每个处理器都必须通过 runtime.commit() 保存进度：
	// 回调会返回下一个检查点或最终结果；该状态与回调写入的其他内容一并提交保存。
	phases: {
		prepare: async (task, runtime, taskContext) => {
			await runtime.commit(
				() => ({ status: "running", checkpoint: { phase: "charge", key: `payment-${task.id}` } }),
				taskContext,
			);
		},
		charge: async (task, runtime, taskContext) => {
			const key = task.state.checkpoint.key;
			if (!payments.has(key)) payments.set(key, task.input.amount * 100);
			const receipt = payments.get(key)!;
			await runtime.commit(
				() => ({ status: "terminal", outcome: { status: "completed", result: { receipt } } }),
				taskContext,
			);
		},
	},
	// 调用 harness.abortTask() 后会运行此处理器，而不是各阶段处理器；由它决定最终结果。
	abort: async (_task, runtime, taskContext) => {
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext);
	},
});

// 扩展提供任务代码，Harness 会通过注册表按名称查找任务。
// 在调用 resume() 或 waitForTask() 等等待进度的方法前，任务不会运行。
const registry = createRegistry();
registry.install(defineExtension({ name: "payments", tasks: [Payment] }));
const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry }, context);
const root = await harness.root(context);
// 每个任务都要指定所有者。本例中的任务归属当前对话；任务也可以拥有子任务并等待它们完成（见 24-child-tasks.ts）。
const paymentId = await root.commit(
	(tx) => tx.createTask(Payment, { amount: 5 }, { ownership: { kind: "conversation" } }),
	context,
);
// 已完成的任务记录是持久化凭据；waitForTask() 能识别其结果类型。
const paid = await harness.waitForTask(paymentId, context);
console.log("payment outcome:", paid.state.outcome);

await harness.close(context);
