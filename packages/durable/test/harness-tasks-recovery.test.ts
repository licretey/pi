import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context, JsonValue } from "@earendil-works/chord";
import { createModels, Type } from "@earendil-works/pi-ai";
import {
	createRegistry,
	defineDoc,
	defineTask,
	defineTool,
	Harness,
	MemoryStorage,
	type Registry,
	type Task,
	type TaskId,
	type TaskRuntime,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { addTask, addTool } from "./harness-support.ts";
import { ControlledStorage, context, flush } from "./session-support.ts";
import { aborted, abortedWith, completed, countingReader, deferred, eventually, openTasks } from "./task-support.ts";

const directories = new Set<string>();

async function sqlitePath(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-durable-tasks-"));
	directories.add(directory);
	return join(directory, "session.sqlite");
}

afterEach(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
	directories.clear();
});

type OpenHarness = Awaited<ReturnType<typeof openTasks>>["harness"];

async function createIn<S extends { phase: string }, R>(
	harness: OpenHarness,
	task: Task<null, S, R, object>,
): Promise<TaskId<R>> {
	const root = await harness.root(context);
	return root.commit((tx) => tx.createTask(task, null, { ownership: { kind: "conversation" } }), context);
}

/** 操作按请求键实现幂等性的模拟外部服务。 */
class TransferService {
	readonly applied = new Map<string, number>();
	calls = 0;

	async apply(key: string, amount: number): Promise<number> {
		this.calls++;
		if (!this.applied.has(key)) this.applied.set(key, amount * 10);
		return this.applied.get(key)!;
	}
}

type TransferState = { phase: "prepare" } | { phase: "apply"; key: string };

/**
 * 意图/效果/结果任务：`prepare` 提交意图，`apply` 执行效果并提交结果。
 * 设置 `interrupt.first` 时，第一次 `apply` 会在效果执行后阻塞，直到调用收到中止信号。
 */
function transferTask(service: TransferService, interrupt: { first: boolean }) {
	return defineTask<{ amount: number }, TransferState, { receipt: number }>({
		name: "test.transfer",
		version: 1,
		initial: () => ({ phase: "prepare" }),
		phases: {
			prepare: async (task, runtime, ctx) => {
				await runtime.memo("requested", task.input.amount, ctx);
				await runtime.commit(
					() => ({ status: "running", checkpoint: { phase: "apply", key: `transfer-${task.id}` } }),
					ctx,
				);
			},
			apply: async (task, runtime, ctx) => {
				const receipt = await service.apply(task.state.checkpoint.key, task.input.amount);
				if (interrupt.first) {
					interrupt.first = false;
					await aborted(runtime.signal);
				}
				await runtime.commit(() => completed({ receipt }), ctx);
			},
		},
		abort: async (_task, runtime, ctx) => {
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
		},
	});
}

type Step = { phase: "run" };

/** 带版本号的单阶段任务，以 `result` 完成，并可选择迁移旧记录。 */
function versioned(
	version: number,
	result: string,
	migrate?: (input: JsonValue, checkpoint: JsonValue, fromVersion: number) => { input: null; checkpoint: Step },
) {
	return defineTask<null, Step, JsonValue>({
		name: "test.versioned",
		version,
		initial: () => ({ phase: "run" }),
		phases: { run: (_task, runtime, ctx) => runtime.commit(() => completed(result), ctx) },
		abort: (_task, runtime, ctx) => runtime.commit(() => abortedWith(result), ctx),
		...(migrate === undefined ? {} : { migrate }),
	});
}

describe("task recovery", () => {
	it("resumes an intent/effect/outcome task interrupted after its intent across close and reopen", async () => {
		const path = await sqlitePath();
		const service = new TransferService();
		const Transfer = transferTask(service, { first: true });

		const first = await openTasks(await openNodeSqliteStorage(path), [Transfer]);
		const root = await first.harness.root(context);
		const id = await root.commit(
			(tx) => tx.createTask(Transfer, { amount: 7 }, { ownership: { kind: "conversation" } }),
			context,
		);
		first.harness.resume();
		await eventually(() => service.calls === 1);
		await first.harness.close(context);

		const second = await openTasks(await openNodeSqliteStorage(path), [Transfer]);
		// 打开存储时已将 `running` 状态协调为 `pending`，并保留检查点和 memo；任务尚未运行。
		expect(await second.harness.getTask(id, context)).toMatchObject({
			abortRequested: false,
			memos: { requested: 7 },
			state: { status: "pending", checkpoint: { phase: "apply", key: `transfer-${id}` } },
		});
		expect(service.calls).toBe(1);
		second.harness.resume();
		const receipt = await second.harness.waitForTask(id, context);
		expect(receipt.state.outcome).toEqual({ status: "completed", result: { receipt: 70 } });
		expect(service.calls).toBe(2);
		expect(service.applied.size).toBe(1);
		await second.harness.close(context);

		const third = await openTasks(await openNodeSqliteStorage(path), [Transfer]);
		expect(await third.harness.getTask(id, context)).toEqual(receipt);
		await third.harness.close(context);
	});

	// #10549
	it("keeps a task's startedAt across close and reopen and stamps endedAt when it settles", async () => {
		const path = await sqlitePath();
		const service = new TransferService();
		const Transfer = transferTask(service, { first: true });
		let clock = 2_000;
		const now = () => clock;

		const first = await openTasks(await openNodeSqliteStorage(path), [Transfer], { now });
		const root = await first.harness.root(context);
		const id = await root.commit(
			(tx) => tx.createTask(Transfer, { amount: 7 }, { ownership: { kind: "conversation" } }),
			context,
		);
		first.harness.resume();
		await eventually(() => service.calls === 1);
		clock = 3_000;
		await first.harness.close(context);

		clock = 9_000;
		const second = await openTasks(await openNodeSqliteStorage(path), [Transfer], { now });
		const reopened = await second.harness.getTask(id, context);
		expect([reopened?.state.status, reopened?.startedAt, reopened?.endedAt]).toEqual(["pending", 2_000, undefined]);
		second.harness.resume();
		const receipt = await second.harness.waitForTask(id, context);
		expect([receipt.startedAt, receipt.endedAt]).toEqual([2_000, 9_000]);
		await second.harness.close(context);
	});

	it("resumes abort work after close at every direct-task abort stage", async () => {
		const path = await sqlitePath();
		const log: string[] = [];
		const abortGate = { block: true };
		const abortReached = deferred();
		const runRelease = deferred();
		const Abortable = defineTask<null, Step, null>({
			name: "test.abortable",
			version: 1,
			initial: () => ({ phase: "run" }),
			phases: {
				run: async () => {
					log.push("run");
					// 释放前忽略中止信号，因此运行期间中止标记已持久化。
					await runRelease.promise;
				},
			},
			abort: async (_task, runtime, ctx) => {
				log.push("abort");
				if (abortGate.block) {
					abortReached.resolve();
					await aborted(runtime.signal);
				}
				await runtime.commit(() => abortedWith("stop"), ctx);
			},
		});

		// 阶段 1：运行调用仍在执行时，中止标记已提交。
		let opened = await openTasks(await openNodeSqliteStorage(path), [Abortable]);
		const id = await createIn(opened.harness, Abortable);
		opened.harness.resume();
		await eventually(() => log.length === 1);
		const aborting = opened.harness.abortTask(id, context);
		while (!(await opened.harness.getTask(id, context))?.abortRequested) await flush();
		const closing = opened.harness.close(context);
		runRelease.resolve();
		await closing;
		expect(await aborting).toBe("marked");
		expect(log).toEqual(["run"]);

		// 阶段 2：重新打开后会分派中止调用，而不会再次运行任务；在中止调用仍执行时关闭。
		opened = await openTasks(await openNodeSqliteStorage(path), [Abortable]);
		expect(await opened.harness.getTask(id, context)).toMatchObject({
			abortRequested: true,
			state: { status: "pending" },
		});
		opened.harness.resume();
		await abortReached.promise;
		await opened.harness.close(context);
		expect(log).toEqual(["run", "abort"]);

		// 阶段 3：新的中止调用将任务置为终态。
		abortGate.block = false;
		opened = await openTasks(await openNodeSqliteStorage(path), [Abortable]);
		opened.harness.resume();
		expect((await opened.harness.waitForTask(id, context)).state.outcome).toEqual({
			status: "aborted",
			reason: "stop",
		});
		await opened.harness.close(context);
		expect(log).toEqual(["run", "abort", "abort"]);

		// 阶段 4：重新打开后终态回执仍然存在，任务不会再次运行。
		opened = await openTasks(await openNodeSqliteStorage(path), [Abortable]);
		opened.harness.resume();
		await flush();
		expect(await opened.harness.abortTask(id, context)).toBe("terminal");
		await opened.harness.close(context);
		expect(log).toEqual(["run", "abort", "abort"]);
	});
});

/**
 * 崩溃模拟：Harness 崩溃后不调用 close，暂存的存储提交不会落盘，阻塞中的处理器也不会返回；
 * 随后由新的 Harness 打开同一份存储。
 */
describe("task crash recovery", () => {
	type Log = string[];

	/** 运行过程忽略信号、且 `blockAbort` 为真时中止处理器会阻塞的任务。 */
	function crashTask(log: Log, options: { blockAbort: boolean }) {
		return defineTask<null, Step, null>({
			name: "test.crash",
			version: 1,
			initial: () => ({ phase: "run" }),
			phases: {
				run: async () => {
					log.push("run");
					await new Promise(() => {});
				},
			},
			abort: async (_task, runtime, ctx) => {
				log.push("abort");
				if (options.blockAbort) await new Promise(() => {});
				await runtime.commit(() => abortedWith("recovered"), ctx);
			},
		});
	}

	async function recover(storage: ControlledStorage, log: Log): Promise<{ harness: OpenHarness; id: TaskId }> {
		storage.crash();
		const { harness } = await openTasks(storage, [crashTask(log, { blockAbort: false })]);
		const page = await harness.commit((tx) => tx.scanTasks({ kind: "test.crash" }, 1), context);
		return { harness, id: page.items[0]!.id };
	}

	async function crashedRun(log: Log): Promise<{ storage: ControlledStorage; harness: OpenHarness; id: TaskId }> {
		const storage = new ControlledStorage();
		const { harness } = await openTasks(storage, [crashTask(log, { blockAbort: true })]);
		const id = await createIn(harness, crashTask(log, { blockAbort: true }));
		harness.resume();
		await eventually(() => log.length === 1);
		return { storage, harness, id };
	}

	it("crash while the mark commit is in storage: the run resumes", async () => {
		const log: Log = [];
		const { storage, harness, id } = await crashedRun(log);
		const held = storage.holdCommits();
		void harness.abortTask(id, context);
		await held.entered;
		const recovered = await recover(storage, log);
		expect(await recovered.harness.getTask(id, context)).toMatchObject({
			abortRequested: false,
			state: { status: "pending" },
		});
		recovered.harness.resume();
		await eventually(() => log.length === 2);
		expect(log).toEqual(["run", "run"]);
	});

	it("crash after the mark before the run joins: only the abort handler runs", async () => {
		const log: Log = [];
		const { storage, harness, id } = await crashedRun(log);
		// 运行过程忽略信号，因此 abortTask 始终无法等待它结束。
		let joined = false;
		void harness.abortTask(id, context).then(() => {
			joined = true;
		});
		while (!(await harness.getTask(id, context))?.abortRequested) await flush();
		await flush();
		expect(joined).toBe(false);
		const recovered = await recover(storage, log);
		expect(await recovered.harness.getTask(id, context)).toMatchObject({
			abortRequested: true,
			state: { status: "pending" },
		});
		recovered.harness.resume();
		expect((await recovered.harness.waitForTask(id, context)).state.outcome).toEqual({
			status: "aborted",
			reason: "recovered",
		});
		expect(log).toEqual(["run", "abort"]);
		await recovered.harness.close(context);
	});

	it("crash while the abort handler runs: a fresh abort invocation settles the task", async () => {
		const log: Log = [];
		const storage = new ControlledStorage();
		const Crash = crashTask(log, { blockAbort: true });
		const { harness } = await openTasks(storage, [Crash]);
		const id = await createIn(harness, Crash);
		await harness.abortTask(id, context);
		harness.resume();
		await eventually(() => log.length === 1);
		expect(log).toEqual(["abort"]);
		expect(await harness.getTask(id, context)).toMatchObject({ state: { status: "running" } });
		const recovered = await recover(storage, log);
		recovered.harness.resume();
		expect((await recovered.harness.waitForTask(id, context)).state.outcome).toEqual({
			status: "aborted",
			reason: "recovered",
		});
		expect(log).toEqual(["abort", "abort"]);
		await recovered.harness.close(context);
	});

	it("crash while the abort outcome is in storage: the abort handler runs again", async () => {
		const log: Log = [];
		const storage = new ControlledStorage();
		const reached = deferred();
		const proceed = deferred();
		const Crash = defineTask<null, Step, null>({
			name: "test.crash",
			version: 1,
			initial: () => ({ phase: "run" }),
			phases: { run: async () => {} },
			abort: async (_task, runtime, ctx) => {
				log.push("abort");
				reached.resolve();
				await proceed.promise;
				await runtime.commit(() => abortedWith("lost"), ctx);
			},
		});
		const { harness } = await openTasks(storage, [Crash]);
		const id = await createIn(harness, Crash);
		await harness.abortTask(id, context);
		harness.resume();
		await reached.promise;
		const held = storage.holdCommits();
		proceed.resolve();
		await held.entered;
		const recovered = await recover(storage, log);
		recovered.harness.resume();
		expect((await recovered.harness.waitForTask(id, context)).state.outcome).toEqual({
			status: "aborted",
			reason: "recovered",
		});
		expect(log).toEqual(["abort", "abort"]);
		await recovered.harness.close(context);
	});

	it("crash after the terminal outcome: nothing runs again", async () => {
		const log: Log = [];
		const storage = new ControlledStorage();
		const Crash = crashTask(log, { blockAbort: false });
		const { harness } = await openTasks(storage, [Crash]);
		const id = await createIn(harness, Crash);
		await harness.abortTask(id, context);
		harness.resume();
		await harness.waitForTask(id, context);
		const recovered = await recover(storage, log);
		recovered.harness.resume();
		await flush();
		expect(log).toEqual(["abort"]);
		expect((await recovered.harness.getTask(id, context))?.state).toEqual({
			status: "terminal",
			outcome: { status: "aborted", reason: "recovered" },
		});
		await recovered.harness.close(context);
	});

	it("crash while the reservation commit is in storage: the task is still pending", async () => {
		const log: Log = [];
		const storage = new ControlledStorage();
		const Crash = crashTask(log, { blockAbort: false });
		const { harness } = await openTasks(storage, [Crash]);
		const id = await createIn(harness, Crash);
		const held = storage.holdCommits();
		harness.resume();
		await held.entered;
		const recovered = await recover(storage, log);
		expect((await recovered.harness.getTask(id, context))?.state.status).toBe("pending");
		expect(log).toEqual([]);
		await recovered.harness.abortTask(id, context);
		recovered.harness.resume();
		await recovered.harness.waitForTask(id, context);
		expect(log).toEqual(["abort"]);
		await recovered.harness.close(context);
	});
});

describe("blocked tasks", () => {
	it("keeps a task with a missing definition pending, and live for idle waits, until registration", async () => {
		const V1 = versioned(1, "v1");
		const { harness, registry } = await openTasks(new MemoryStorage(), []);
		const id = await createIn(harness, V1);
		harness.resume();
		await flush();
		expect((await harness.getTask(id, context))?.state.status).toBe("pending");
		const idle = harness.waitForIdle(context);
		await flush();
		addTask(registry, V1);
		await idle;
		expect((await harness.getTask(id, context))?.state).toEqual({
			status: "terminal",
			outcome: { status: "completed", result: "v1" },
		});
		await harness.close(context);
	});

	it("keeps a task stored by a newer version pending until a fitting definition is registered", async () => {
		const registry = createRegistry();
		addTask(registry, versioned(1, "old"));
		const { harness } = await openTasks(new MemoryStorage(), [], { registry });
		const id = await createIn(harness, versioned(2, "new"));
		harness.resume();
		await flush();
		expect((await harness.getTask(id, context))?.state.status).toBe("pending");
		// 同名扩展会原位替换旧定义。
		addTask(registry, versioned(2, "new"));
		expect((await harness.waitForTask(id, context)).state.outcome).toEqual({ status: "completed", result: "new" });
		await harness.close(context);
	});

	it("migrates at reservation, leaves the record unchanged when migration fails, and retries only for a new definition", async () => {
		const path = await sqlitePath();
		let opened = await openTasks(await openNodeSqliteStorage(path), []);
		const id = await createIn(opened.harness, versioned(1, "v1"));
		await opened.harness.close(context);

		const registry: Registry = createRegistry();
		let failures = 0;
		addTask(
			registry,
			versioned(2, "v2", () => {
				failures++;
				throw new Error("cannot migrate");
			}),
		);
		opened = await openTasks(await openNodeSqliteStorage(path), [], { registry });
		opened.harness.resume();
		await eventually(() => opened.reports.length === 1);
		// 无关的注册表变更会唤醒调度器，但不会重试同一个失败的定义。
		addTool(
			registry,
			defineTool({
				name: "unrelated",
				description: "unrelated",
				parameters: Type.Object({}),
				execute: async () => ({}),
			}),
		);
		await flush();
		expect(failures).toBe(1);
		expect(opened.reports).toHaveLength(1);
		expect(String(opened.reports[0])).toContain("cannot migrate");
		expect(await opened.harness.getTask(id, context)).toMatchObject({
			version: 1,
			state: { status: "pending", checkpoint: { phase: "run" } },
		});

		const migrations: number[] = [];
		// 同名扩展会原位替换旧定义。
		addTask(
			registry,
			versioned(2, "v2", (_input, checkpoint, fromVersion) => {
				migrations.push(fromVersion);
				return { input: null, checkpoint: checkpoint as Step };
			}),
		);
		const receipt = await opened.harness.waitForTask(id, context);
		expect(receipt).toMatchObject({ version: 2, state: { outcome: { status: "completed", result: "v2" } } });
		expect(migrations).toEqual([1]);
		await opened.harness.close(context);
	});

	it("blocks an older record whose newer definition has no migration", async () => {
		const path = await sqlitePath();
		let opened = await openTasks(await openNodeSqliteStorage(path), []);
		const id = await createIn(opened.harness, versioned(1, "v1"));
		await opened.harness.close(context);
		opened = await openTasks(await openNodeSqliteStorage(path), [versioned(2, "v2")]);
		opened.harness.resume();
		await eventually(() => opened.reports.length === 1);
		expect(String(opened.reports[0])).toContain("has no migration from 1");
		expect(await opened.harness.getTask(id, context)).toMatchObject({ version: 1, state: { status: "pending" } });
		await opened.harness.close(context);
	});

	it("settles an aborted blocked task as orphaned and retires its documents", async () => {
		const Scratch = defineDoc<{ n: number }>({
			kind: "test.orphan-scratch",
			version: 1,
			scope: "task",
			initial: () => ({ n: 0 }),
		});
		const { harness } = await openTasks(new MemoryStorage(), []);
		const root = await harness.root(context);
		const id = await root.commit(async (tx) => {
			const created = await tx.createTask(versioned(1, "x"), null, { ownership: { kind: "conversation" } });
			(await tx.doc(Scratch, created)).n = 1;
			return created;
		}, context);
		// 恢复调度前：写入标记的提交会直接将被阻塞的任务置为终态。
		expect(await harness.abortTask(id, context)).toBe("marked");
		expect((await harness.getTask(id, context))?.state).toEqual({
			status: "terminal",
			outcome: { status: "orphaned", reason: "missing_task" },
		});
		expect(await harness.snapshot(Scratch, id, context)).toBeUndefined();
		await harness.close(context);
	});

	it("orphans a marked task whose definition disappeared while its run was active", async () => {
		const reached = deferred();
		const Running = defineTask<null, Step, null>({
			name: "test.vanishing",
			version: 1,
			initial: () => ({ phase: "run" }),
			phases: {
				run: async (_task, runtime) => {
					reached.resolve();
					await aborted(runtime.signal);
				},
			},
			abort: async () => {
				throw new Error("must not run");
			},
		});
		const registry = createRegistry();
		const registration = addTask(registry, Running);
		const { harness } = await openTasks(new MemoryStorage(), [], { registry });
		const id = await createIn(harness, Running);
		harness.resume();
		await reached.promise;
		registration.dispose();
		// 运行仍在执行时，标记不会立即使任务变为孤立状态；运行结束后由调度器将其置为孤立状态。
		expect(await harness.abortTask(id, context)).toBe("marked");
		expect((await harness.waitForTask(id, context)).state.outcome).toEqual({
			status: "orphaned",
			reason: "missing_task",
		});
		await harness.close(context);
	});

	it("orphans a reopened abort-marked task without a definition once scheduling resumes", async () => {
		const path = await sqlitePath();
		let opened = await openTasks(await openNodeSqliteStorage(path), [versioned(1, "x")]);
		const id = await createIn(opened.harness, versioned(1, "x"));
		expect(await opened.harness.abortTask(id, context)).toBe("marked");
		await opened.harness.close(context);

		opened = await openTasks(await openNodeSqliteStorage(path), []);
		expect(await opened.harness.getTask(id, context)).toMatchObject({
			abortRequested: true,
			state: { status: "pending" },
		});
		const idle = opened.harness.waitForIdle(context);
		opened.harness.resume();
		await idle;
		expect((await opened.harness.getTask(id, context))?.state).toEqual({
			status: "terminal",
			outcome: { status: "orphaned", reason: "missing_task" },
		});
		await opened.harness.close(context);
	});
});

describe("definition handover", () => {
	type Handover = { phase: "a" } | { phase: "b" } | { phase: "c" };
	type Gates = { readonly a?: Promise<void>; readonly b?: Promise<void>; readonly onEnd?: () => void };

	function handoverTask(
		label: string,
		version: number,
		log: string[],
		options: { readonly gates?: Gates; readonly migrate?: () => { input: null; checkpoint: Handover } } = {},
	) {
		const advance =
			(phase: "a" | "b", next: Handover) =>
			async (_task: unknown, runtime: TaskRuntime<null, Handover, null, object>, ctx: Context) => {
				log.push(`${label}:${phase} start`);
				await options.gates?.[phase];
				await runtime.commit(() => ({ status: "running", checkpoint: next }), ctx);
				// 在本次调用结束前留出时间，以便错误分派的后继阶段有机会启动。
				await flush();
				options.gates?.onEnd?.();
				log.push(`${label}:${phase} end`);
			};
		return defineTask<null, Handover, null>({
			name: "test.handover",
			version,
			initial: () => ({ phase: "a" }),
			phases: {
				a: advance("a", { phase: "b" }),
				b: advance("b", { phase: "c" }),
				c: async (_task, runtime, ctx) => {
					log.push(`${label}:c`);
					await runtime.commit(() => completed(null), ctx);
				},
			},
			abort: async (_task, runtime, ctx) => {
				log.push(`${label}:abort`);
				await runtime.commit(() => abortedWith(label), ctx);
			},
			...(options.migrate === undefined ? {} : { migrate: options.migrate }),
		});
	}

	async function startHandover(log: string[], gates: Gates, storage = new MemoryStorage()) {
		const registry = createRegistry();
		const old = addTask(registry, handoverTask("old", 1, log, { gates }));
		const opened = await openTasks(storage, [], { registry });
		const id = await createIn(opened.harness, handoverTask("old", 1, log));
		opened.harness.resume();
		await eventually(() => log.length === 1);
		return { ...opened, old, id };
	}

	it("hands over at the next phase boundary to a same-version replacement without overlap", async () => {
		const log: string[] = [];
		const gate = deferred();
		const { harness, registry, id } = await startHandover(log, { a: gate.promise });
		// 同名扩展会原位替换旧定义。
		addTask(registry, handoverTask("new", 1, log));
		gate.resolve();
		await harness.waitForTask(id, context);
		expect(log).toEqual(["old:a start", "old:a end", "new:b start", "new:b end", "new:c"]);
		await harness.close(context);
	});

	it("keeps the memos across a handover", async () => {
		type Memoed = { phase: "a" } | { phase: "b" };
		const log: string[] = [];
		const gate = deferred();
		const reached = deferred();
		const memoTask = (label: string) =>
			defineTask<null, Memoed, string>({
				name: "test.handover-memo",
				version: 1,
				initial: () => ({ phase: "a" }),
				phases: {
					a: async (_task, runtime, ctx) => {
						await runtime.memo("picked", label, ctx);
						reached.resolve();
						await gate.promise;
						await runtime.commit(() => ({ status: "running", checkpoint: { phase: "b" } }), ctx);
					},
					b: async (_task, runtime, ctx) => {
						// 候选值优先级低于旧定义已存储的 memo。
						const picked = await runtime.memo("picked", label, ctx);
						log.push(`${label}:b ${picked}`);
						await runtime.commit(() => completed(picked), ctx);
					},
				},
				abort: async () => {},
			});
		const registry = createRegistry();
		addTask(registry, memoTask("old"));
		const { harness } = await openTasks(new MemoryStorage(), [], { registry });
		const id = await createIn(harness, memoTask("old"));
		harness.resume();
		await reached.promise;
		addTask(registry, memoTask("new"));
		gate.resolve();
		const receipt = await harness.waitForTask(id, context);
		expect(receipt.state.outcome).toEqual({ status: "completed", result: "old" });
		expect(log).toEqual(["new:b old"]);
		await harness.close(context);
	});

	it("hands over to a newer version with a migration", async () => {
		const log: string[] = [];
		const gate = deferred();
		const { harness, registry, id } = await startHandover(log, { a: gate.promise });
		// 同名扩展会原位替换旧定义。
		addTask(registry, handoverTask("v2", 2, log, { migrate: () => ({ input: null, checkpoint: { phase: "c" } }) }));
		gate.resolve();
		const receipt = await harness.waitForTask(id, context);
		expect(receipt.version).toBe(2);
		expect(log).toEqual(["old:a start", "old:a end", "v2:c"]);
		await harness.close(context);
	});

	it("hands over to a newer version whose migration fails and leaves the task blocked", async () => {
		const log: string[] = [];
		const gate = deferred();
		const { harness, registry, id, reports } = await startHandover(log, { a: gate.promise });
		// 同名扩展会原位替换旧定义。
		addTask(
			registry,
			handoverTask("broken", 2, log, {
				migrate: () => {
					throw new Error("broken migration");
				},
			}),
		);
		gate.resolve();
		await eventually(() => reports.length === 1);
		await flush();
		expect(await harness.getTask(id, context)).toMatchObject({
			version: 1,
			state: { status: "pending", checkpoint: { phase: "b" } },
		});
		expect(log).toEqual(["old:a start", "old:a end"]);
		await harness.close(context);
	});

	it("keeps running under the old definition when the replacement is missing or cannot take the task", async () => {
		const log: string[] = [];
		const gateA = deferred();
		const gateB = deferred();
		const { harness, registry, old, id, reports } = await startHandover(log, { a: gateA.promise, b: gateB.promise });
		old.dispose();
		gateA.resolve();
		await eventually(() => log.includes("old:b start"));
		// 没有迁移函数的新版本定义也无法接管该任务。
		addTask(registry, handoverTask("incompatible", 2, log));
		gateB.resolve();
		await harness.waitForTask(id, context);
		expect(log).toEqual(["old:a start", "old:a end", "old:b start", "old:b end", "old:c"]);
		expect(reports.map((report) => (report as Error).cause)).toEqual(["missing_task", "incompatible_task"]);
		await harness.close(context);
	});

	it("rejects a runtime commit of the old invocation queued behind its handover commit", async () => {
		const log: string[] = [];
		const gate = deferred();
		const storage = new ControlledStorage();
		let held: ReturnType<ControlledStorage["holdCommits"]> | undefined;
		let oldRuntime: TaskRuntime<null, Handover, null, object> | undefined;
		let harnessRef: OpenHarness | undefined;
		const registry = createRegistry();
		const Old = defineTask<null, Handover, null>({
			name: "test.handover",
			version: 1,
			initial: () => ({ phase: "a" }),
			phases: {
				a: async (task, runtime, ctx) => {
					oldRuntime = runtime;
					await gate.promise;
					await runtime.commit(() => ({ status: "running", checkpoint: { phase: "b" } }), ctx);
					// 用无关提交占住串行队列，使交接提交排在其后。
					held = storage.holdCommits();
					void harnessRef!.commit(async (tx) => {
						await tx.appendEntry(task.conversationId, { kind: "blocker" });
					}, ctx);
				},
				b: async () => {},
				c: async () => {},
			},
			abort: async () => {},
		});
		addTask(registry, Old);
		const { harness } = await openTasks(storage, [], { registry });
		harnessRef = harness;
		const id = await createIn(harness, Old);
		harness.resume();
		await eventually(() => oldRuntime !== undefined);
		// 同名扩展会原位替换旧定义。
		addTask(registry, handoverTask("new", 1, log));
		gate.resolve();
		await eventually(() => held !== undefined);
		await held!.entered;
		await flush();
		// 在调用尚未结束时排入队列，但执行顺序位于交接提交之后。
		const late = oldRuntime!.commit(() => completed(null), context);
		held!.release();
		await expect(late).rejects.toThrow("invocation has ended");
		await harness.waitForTask(id, context);
		expect(log).toEqual(["new:b start", "new:b end", "new:c"]);
		await harness.close(context);
	});

	it("preserves an abort mark that races the handover commit; the new definition aborts", async () => {
		const log: string[] = [];
		const gate = deferred();
		const storage = new ControlledStorage();
		let held: ReturnType<ControlledStorage["holdCommits"]> | undefined;
		// 进展提交已落盘；暂停后续提交（即交接提交），并将中止标记排在它后面。
		const gates: Gates = {
			a: gate.promise,
			onEnd: () => {
				held ??= storage.holdCommits();
			},
		};
		const { harness, registry, id } = await startHandover(log, gates, storage);
		// 同名扩展会原位替换旧定义。
		addTask(registry, handoverTask("new", 1, log));
		gate.resolve();
		await eventually(() => held !== undefined);
		await held!.entered;
		const aborting = harness.abortTask(id, context);
		held!.release();
		expect(await aborting).toBe("marked");
		expect((await harness.waitForTask(id, context)).state.outcome).toEqual({ status: "aborted", reason: "new" });
		const states = storage.commits.flatMap((writes) =>
			writes.flatMap((write) =>
				write.type === "task" && write.value.id === id
					? [`${write.value.state.status}${write.value.abortRequested ? "+mark" : ""}`]
					: [],
			),
		);
		// 创建、预留、进展、交接、标记、中止预留、中止完成。
		expect(states).toEqual([
			"pending",
			"running",
			"running",
			"pending",
			"pending+mark",
			"running+mark",
			"terminal+mark",
		]);
		expect(log).toEqual(["old:a start", "old:a end", "new:abort"]);
		await harness.close(context);
	});
});

describe("Harness open", () => {
	it("releases its registry subscription and closes the Session when open fails", async () => {
		const storage = new ControlledStorage();
		const log: string[] = [];
		const Stuck = defineTask<null, Step, null>({
			name: "test.stuck",
			version: 1,
			initial: () => ({ phase: "run" }),
			phases: {
				run: async () => {
					log.push("run");
					await new Promise(() => {});
				},
			},
			abort: async () => {},
		});
		// 留下一个运行中的任务，以便 open 执行协调提交并触发失败。
		const first = await openTasks(storage, [Stuck]);
		await createIn(first.harness, Stuck);
		first.harness.resume();
		await eventually(() => log.length === 1);

		const registry = createRegistry();
		const reader = countingReader(registry);
		storage.failNextCommit(new Error("disk full"));
		await expect(Harness.open(storage, { models: createModels(), registry: reader }, context)).rejects.toThrow(
			"disk full",
		);
		expect(reader.subscriptions()).toBe(0);
		await expect(storage.task(1 as TaskId, context)).rejects.toThrow();
	});
});
