// 关闭并重新打开 Harness，从任务停止的位置继续执行。
// 在 packages/durable 目录下运行：
//   node --conditions=source --experimental-strip-types test/examples/13-recovery.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineExtension, defineTask, Harness } from "../../src/index.ts";
import { openNodeSqliteStorage } from "../../src/storage/sqlite/node.ts";

const context = BACKGROUND_CONTEXT;

// 任务继续执行所需的全部信息都保存在存储中，因此基于同一存储新建 Harness 后，
// 就能从上次停止的位置继续。本示例将数据保存在 SQLite 文件中，使其在关闭后仍然存在。
const directory = await mkdtemp(join(tmpdir(), "pi-durable-example-"));
const databasePath = join(directory, "session.sqlite");

let reachedTick = (_n: number): void => {};
const Ticker = defineTask<{ to: number }, { phase: "tick"; n: number }, string>({
	name: "example.ticker",
	version: 1,
	initial: () => ({ phase: "tick", n: 1 }),
	phases: {
		tick: async (task, runtime, taskContext) => {
			const n = task.state.checkpoint.n;
			// 在副作用发生前保存执行意图。备忘录会保留以其名称写入的第一个值，因此如果进程在打印后、
			// 保存下一个检查点前退出，重跑时就能读取备忘录，避免重复打印同一个 tick。
			if ((await runtime.memo(`printed-${n}`, taskContext)) === undefined) {
				await runtime.memo(`printed-${n}`, true, taskContext);
				console.log(`tick ${n}`);
			}
			reachedTick(n);
			// 保存执行结果：进入下一个 tick，或记录最终结果。
			await runtime.commit(
				() =>
					n === task.input.to
						? { status: "terminal", outcome: { status: "completed", result: `counted to ${n}` } }
						: { status: "running", checkpoint: { phase: "tick", n: n + 1 } },
				taskContext,
			);
			// 在 tick 之间稍作等待。关闭 Harness 会取消此次等待；下一个 Harness 会从上面保存的检查点继续。
			await runtime.sleep(Date.now() + 50, taskContext);
		},
	},
	abort: async (_task, runtime, taskContext) => {
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext);
	},
});
const registry = createRegistry();
registry.install(defineExtension({ name: "ticker", tasks: [Ticker] }));
const open = async () =>
	Harness.open(await openNodeSqliteStorage(databasePath), { models: createModels(), registry }, context);

// 首次运行：开始计数至 5，在打印 tick 2 后、保存下一个检查点前关闭 Harness。
// 这模拟了副作用已发生、但结果尚未保存时进程崩溃的情况。
const firstRun = await open();
const tickerId = await (await firstRun.root(context)).commit(
	(tx) => tx.createTask(Ticker, { to: 5 }, { ownership: { kind: "conversation" } }),
	context,
);
const tickTwo = new Promise<void>((resolve) => {
	reachedTick = (n) => {
		if (n === 2) resolve();
	};
});
firstRun.resume();
await tickTwo;
await firstRun.close(context);
reachedTick = () => {};

// 通过不会恢复任务的 Harness 读取已保存记录，因此不会执行任何任务。
const reader = await open();
const saved = (await reader.getTask(tickerId, context))!;
await reader.close(context);
console.log("closed; saved checkpoint:", saved.state, "memos:", saved.memos);

// 再次运行时无需手动重启任务。等待未完成的任务会启用调度并继续执行。
// 由于 tick 2 的结果从未保存，它会再次运行；但备忘录表明它已经打印过。
const secondRun = await open();
const counted = await secondRun.waitForTask(tickerId, context);
console.log("after reopen:", counted.state.outcome);
await secondRun.close(context);
await rm(directory, { recursive: true, force: true });
