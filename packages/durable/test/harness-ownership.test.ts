import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, fauxAssistantMessage, fauxText, fauxToolCall, Type } from "@earendil-works/pi-ai";
import {
	type Conversation,
	type ConversationHandle,
	type ConversationId,
	configure,
	createSession,
	defineDoc,
	defineTask,
	defineTool,
	type EntryId,
	type Harness,
	LiveDoc,
	MemoryStorage,
	type Storage,
	type Submission,
	type TaskId,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { chatSetup, openChat } from "./chat-support.ts";
import { addTask, addTool } from "./harness-support.ts";
import { ControlledStorage, context } from "./session-support.ts";
import { aborted, type Deferred, deferred, openTasks, settled } from "./task-support.ts";

/** 等待门闩打开后，阻塞中的任务提交的结果。 */
type Ending = "completed" | "failed";
const gates = new Map<string, Deferred<Ending>>();

function gate(name: string): Deferred<Ending> {
	let found = gates.get(name);
	if (found === undefined) {
		found = deferred<Ending>();
		gates.set(name, found);
	}
	return found;
}

/** 每个具名任务启动 run 阶段的次数。 */
const runs = new Map<string, number>();

/**
 * 任务会一直等待，直到对应名称的门闩打开或任务被中止。启用 `slowAbort` 时，中止处理器会先等待
 * `abort.<name>` 门闩。
 */
const Hold = defineTask<{ name: string; slowAbort?: boolean }, { phase: "hold" }, null>({
	name: "test.hold",
	version: 1,
	initial: () => ({ phase: "hold" }),
	phases: {
		hold: async (task, runtime, ctx) => {
			runs.set(task.input.name, (runs.get(task.input.name) ?? 0) + 1);
			const ending = await Promise.race([gate(task.input.name).promise, aborted(runtime.signal)]);
			await runtime.commit(
				() =>
					ending === "completed"
						? { status: "terminal", outcome: { status: "completed", result: null } }
						: { status: "terminal", outcome: { status: "failed", error: { message: "gate failed" } } },
				ctx,
			);
		},
	},
	abort: async (task, runtime, ctx) => {
		if (task.input.slowAbort === true) await gate(`abort.${task.input.name}`).promise;
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
	},
});

/** 等待输入中的任务后完成；其中止处理器会将其结束状态设为 `aborted`。 */
const Waiter = defineTask<{ on: TaskId[] }, { phase: "wait" } | { phase: "done" }, null>({
	name: "test.waiter",
	version: 1,
	initial: () => ({ phase: "wait" }),
	phases: {
		wait: async (task, runtime, ctx) => {
			const checkpoint = { phase: "done" } as const;
			await runtime.commit(() => ({ status: "waiting", checkpoint, on: task.input.on, policy: "allSettled" }), ctx);
		},
		done: async (_task, runtime, ctx) =>
			runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx),
	},
	abort: async (_task, runtime, ctx) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});

/** 从未注册；中止它只会使其成为孤儿任务。 */
const Unregistered = defineTask<{ name: string }, { phase: "hold" }, null>({
	name: "test.unregistered",
	version: 1,
	initial: () => ({ phase: "hold" }),
	phases: { hold: async () => {} },
	abort: async () => {},
});

function open(name: string, ending: Ending): void {
	gate(name).resolve(ending);
}

const directories = new Set<string>();
afterEach(async () => {
	gates.clear();
	runs.clear();
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
	directories.clear();
});

type Tree = { owner: TaskId; child: ConversationId; inner: TaskId };

/** 在 `parent` 中通过一次提交暂存任务 `owner`，以及由它拥有、并包含阻塞任务 `inner` 的对话。 */
async function ownedChild(
	parent: Conversation,
	name: string,
	options: { background?: boolean; slowInner?: boolean; slowOwner?: boolean } = {},
): Promise<Tree> {
	return parent.commit(async (tx) => {
		const owner = await tx.createTask(
			Hold,
			{ name, ...(options.slowOwner === true ? { slowAbort: true } : {}) },
			{ ownership: { kind: "conversation" }, background: options.background ?? false },
		);
		const child = await tx.createConversation({ ownership: { kind: "task", taskId: owner } });
		const inner = await tx.createTask(
			Hold,
			{ name: `${name}.inner`, ...(options.slowInner === true ? { slowAbort: true } : {}) },
			{ ownership: { kind: "conversation" }, conversationId: child.id },
		);
		return { owner, child: child.id, inner };
	}, context);
}

/** 模拟响应会一直等待，直到调用 `release` 或被取消；请求发出时 `reached` 会兑现。 */
function gated(message: AssistantMessage) {
	const reached = deferred();
	const gate = deferred();
	const step = async (_request: unknown, options?: { signal?: AbortSignal }) => {
		reached.resolve();
		await Promise.race([gate.promise, aborted(options!.signal!)]);
		return message;
	};
	return { step, reached: reached.promise, release: () => gate.resolve() };
}

async function waitUntil(check: () => Promise<boolean>): Promise<void> {
	for (let attempt = 0; attempt < 500 && !(await check()); attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	if (!(await check())) throw new Error("Condition was not reached");
}

/** 将 `task` 作为对话当前运行任务，使对话处于忙碌状态并让新提交进入队列。 */
async function busy(conversation: Conversation, task: TaskId): Promise<void> {
	await conversation.commit(async (tx) => {
		(await tx.doc(LiveDoc, conversation.id)).run = { taskId: task, inputs: [] };
	}, context);
}

async function status(harness: Harness, id: TaskId) {
	return (await harness.getTask(id, context))!.state;
}

async function openHarness(storage: Storage = new MemoryStorage()) {
	const opened = await openTasks(storage, [Hold, Waiter]);
	const root = await opened.harness.root(context);
	opened.harness.resume();
	return { ...opened, root };
}

describe("ownership", () => {
	it("keeps a conversation busy while its owned foreground subtree has live work, holding the completed owner", async () => {
		const { harness, root } = await openHarness();
		const tree = await ownedChild(root, "owner");
		open("owner", "completed");
		await waitUntil(async () => (await status(harness, tree.owner)).status === "completing");
		const idle = root.waitForIdle(context);
		expect(await settled(idle)).toBe(false);
		expect(await settled(harness.waitForIdle(context))).toBe(false);
		open("owner.inner", "completed");
		await idle;
		await harness.waitForIdle(context);
		expect((await status(harness, tree.owner)).outcome?.status).toBe("completed");
		await harness.close(context);
	});

	it("stops idle traversal at a background owner", async () => {
		const { harness, root } = await openHarness();
		const tree = await ownedChild(root, "background", { background: true });
		await root.waitForIdle(context);
		await harness.waitForIdle(context);
		// 后台子任务拥有独立作用域。
		const child = (await harness.conversation(tree.child, context))!;
		expect(await settled(child.waitForIdle(context))).toBe(false);
		await child.abort(context);
		await harness.close(context);
	});

	it("cascades an abort mark to the owned foreground subtree and withdraws its queued inputs", async () => {
		const { harness, root } = await openHarness();
		const tree = await ownedChild(root, "owner");
		const nested = await harness.conversation(tree.child, context);
		const deeper = await ownedChild(nested!, "deeper");
		const shielded = await ownedChild(nested!, "shielded", { background: true });
		// 忙碌中的对话会将提交排队；内部任务用于模拟子任务的运行。
		await busy(nested!, tree.inner);
		const queued = (await nested!.submit({ type: "input", content: "later" }, context)).id;
		expect(await harness.abortTask(tree.owner, context)).toBe("marked");
		for (const id of [tree.owner, tree.inner, deeper.owner, deeper.inner]) {
			expect((await harness.waitForTask(id, context)).state.outcome.status).toBe("aborted");
		}
		// 嵌套的后台所有者构成边界。
		expect((await status(harness, shielded.owner)).status).not.toBe("terminal");
		expect((await status(harness, shielded.inner)).status).not.toBe("terminal");
		expect(await (await harness.submission(queued, context))!.status(context)).toMatchObject({
			status: "unanswered",
			reason: "aborted",
		});
		await harness.abortTask(shielded.owner, context);
		await harness.close(context);
	});

	it("cascades a failed owner but not a completed one", async () => {
		const { harness, root } = await openHarness();
		const failed = await ownedChild(root, "failed");
		const completedTree = await ownedChild(root, "done");
		open("failed", "failed");
		open("done", "completed");
		expect((await harness.waitForTask(failed.inner, context)).state.outcome.status).toBe("aborted");
		expect((await harness.waitForTask(failed.owner, context)).state.outcome.status).toBe("failed");
		await waitUntil(async () => (await status(harness, completedTree.owner)).status === "completing");
		expect((await status(harness, completedTree.inner)).status).not.toBe("terminal");
		open("done.inner", "completed");
		expect((await harness.waitForTask(completedTree.owner, context)).state.outcome.status).toBe("completed");
		await harness.close(context);
	});

	it("aborts a background task directly with its ordinary subtree", async () => {
		const { harness, root } = await openHarness();
		const tree = await ownedChild(root, "background", { background: true });
		await harness.abortTask(tree.owner, context);
		expect((await harness.waitForTask(tree.inner, context)).state.outcome.status).toBe("aborted");
		await harness.close(context);
	});

	it("aborts a conversation: queued inputs withdrawn, writes kept, foreground work aborted, background kept", async () => {
		const { harness, root } = await openHarness();
		const foreground = await ownedChild(root, "foreground");
		const background = await ownedChild(root, "background", { background: true });
		await busy(root, foreground.owner);
		const input = (await root.submit({ type: "input", content: "later" }, context)).id;
		const write = (await root.submit({ type: "write", entry: { kind: "note" } }, context)).id;
		await root.abort(context);
		for (const id of [foreground.owner, foreground.inner]) {
			expect((await status(harness, id)).status).toBe("terminal");
		}
		expect((await status(harness, background.owner)).status).not.toBe("terminal");
		expect((await status(harness, background.inner)).status).not.toBe("terminal");
		expect(await (await harness.submission(input, context))!.status(context)).toMatchObject({ reason: "aborted" });
		expect((await (await harness.submission(write, context))!.status(context)).status).toBe("queued");
		await harness.abortTask(background.owner, context);
		await harness.close(context);
	});

	it("aborts work created below a held failed owner, but not below a terminal one", async () => {
		const { harness, root } = await openHarness();
		const tree = await ownedChild(root, "owner", { slowInner: true });
		open("owner", "failed");
		await waitUntil(async () => (await harness.getTask(tree.inner, context))!.abortRequested);
		expect((await status(harness, tree.owner)).status).toBe("completing");
		const child = (await harness.conversation(tree.child, context))!;
		const create = (name: string) =>
			child.commit((tx) => tx.createTask(Hold, { name }, { ownership: { kind: "conversation" } }), context);
		const during = await create("during");
		expect((await harness.waitForTask(during, context)).state.outcome.status).toBe("aborted");
		open("abort.owner.inner", "completed");
		expect((await harness.waitForTask(tree.owner, context)).state.outcome.status).toBe("failed");
		// 终态所有者不会触发级联：查询其对话会正常执行。
		const after = await create("after");
		open("after", "completed");
		expect((await harness.waitForTask(after, context)).state.outcome.status).toBe("completed");
		await harness.close(context);
	});

	it("withdraws queued inputs below the aborted task but keeps its own conversation's queue and queued writes", async () => {
		const { harness, root } = await openHarness();
		const tree = await ownedChild(root, "owner");
		const child = (await harness.conversation(tree.child, context))!;
		await busy(root, tree.owner);
		await busy(child, tree.inner);
		const own = (await root.submit({ type: "input", content: "own" }, context)).id;
		const below = (await child.submit({ type: "input", content: "below" }, context)).id;
		const write = (await child.submit({ type: "write", entry: { kind: "note" } }, context)).id;
		await harness.abortTask(tree.owner, context);
		await harness.waitForTask(tree.inner, context);
		const statusOf = async (id: typeof own) =>
			(await (await harness.submission(id, context))!.status(context)).status;
		expect(await statusOf(own)).toBe("queued");
		expect(await statusOf(below)).toBe("unanswered");
		expect(await statusOf(write)).toBe("queued");
		await harness.close(context);
	});

	it("keeps a nested background owner's subtree when its cancelled background owner is aborted", async () => {
		const { harness, root } = await openHarness();
		const outer = await ownedChild(root, "outer", { background: true });
		const inner = await ownedChild((await harness.conversation(outer.child, context))!, "inner", {
			background: true,
		});
		await harness.abortTask(outer.owner, context);
		expect((await harness.waitForTask(outer.inner, context)).state.outcome.status).toBe("aborted");
		expect((await status(harness, inner.owner)).status).not.toBe("terminal");
		expect((await status(harness, inner.inner)).status).not.toBe("terminal");
		await harness.abortTask(inner.owner, context);
		await harness.close(context);
	});

	it("decides idle after reopen from owner edges it has to load first", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-durable-ownership-"));
		directories.add(directory);
		const path = join(directory, "session.sqlite");
		let opened = await openHarness(await openNodeSqliteStorage(path));
		const foreground = await ownedChild(opened.root, "fg");
		const deeper = await ownedChild((await opened.harness.conversation(foreground.child, context))!, "fg2");
		const background = await ownedChild(opened.root, "bg", { background: true });
		open("fg", "completed");
		open("fg2", "completed");
		// 下层工作运行期间，两个所有者都保持其结果状态。
		await waitUntil(async () => (await status(opened.harness, foreground.owner)).status === "completing");
		await waitUntil(async () => (await status(opened.harness, deeper.owner)).status === "completing");
		await opened.harness.close(context);

		opened = await openHarness(await openNodeSqliteStorage(path));
		// 在已完成的前台所有者下方两层，内部任务仍会使根任务保持忙碌。
		expect(await settled(opened.root.waitForIdle(context))).toBe(false);
		expect(await settled(opened.harness.waitForIdle(context))).toBe(false);
		open("fg.inner", "completed");
		open("fg2.inner", "completed");
		// 后台子树不计入其中。
		await opened.root.waitForIdle(context);
		await opened.harness.waitForIdle(context);
		expect((await status(opened.harness, foreground.owner)).status).toBe("terminal");
		expect((await status(opened.harness, background.inner)).status).not.toBe("terminal");
		await opened.harness.abortTask(background.owner, context);
		await opened.harness.close(context);
	});

	for (const [label, abortRequested, state] of [
		[
			"a held failed owner",
			false,
			{ status: "completing", outcome: { status: "failed", error: { message: "crash" } } },
		],
		["an abort-marked owner", true, { status: "pending", checkpoint: { phase: "hold" } }],
	] as const) {
		it(`derives marks a crash left unapplied below ${label} at open`, async () => {
			const directory = await mkdtemp(join(tmpdir(), "pi-durable-ownership-"));
			directories.add(directory);
			const path = join(directory, "session.sqlite");
			// 没有 Harness 时不会派生标记：所有者已取消，但其下仍有运行中的任务。
			const session = createSession(await openNodeSqliteStorage(path));
			const tree = await session.commit(async (tx) => {
				const root = await tx.createConversation({ ownership: { kind: "ownerless" } });
				const owner = await tx.createTask(
					Hold,
					{ name: "gone" },
					{ ownership: { kind: "conversation" }, conversationId: root.id },
				);
				const child = await tx.createConversation({ ownership: { kind: "task", taskId: owner } });
				return {
					owner,
					inner: await tx.createTask(
						Hold,
						{ name: "orphan" },
						{ ownership: { kind: "conversation" }, conversationId: child.id },
					),
				};
			}, context);
			await session.commit(async (tx) => {
				const record = (await tx.task(tree.owner))!;
				(tx as unknown as { setTask(value: unknown): void }).setTask({ ...record, abortRequested, state });
			}, context);
			await session.close(context);

			const { harness } = await openHarness(await openNodeSqliteStorage(path));
			expect((await harness.waitForTask(tree.inner, context)).state.outcome.status).toBe("aborted");
			// 所有者要等下层工作完成后才会结束。
			const outcome = (await harness.waitForTask(tree.owner, context)).state.outcome.status;
			expect(outcome).toBe(abortRequested ? "aborted" : "failed");
			await harness.close(context);
		});
	}

	it("withdraws an input queued below a held failed owner after its cascade", async () => {
		const { harness, root } = await openHarness();
		const tree = await ownedChild(root, "owner", { slowInner: true });
		const child = (await harness.conversation(tree.child, context))!;
		// 内部任务用于模拟子任务运行；级联后它仍保持忙碌。
		await busy(child, tree.inner);
		open("owner", "failed");
		await waitUntil(async () => (await harness.getTask(tree.inner, context))!.abortRequested);
		const late = await child.submit({ type: "input", content: "late" }, context);
		expect(await late.wait(context)).toMatchObject({ status: "unanswered", reason: "aborted" });
		open("abort.owner.inner", "completed");
		await harness.waitForTask(tree.owner, context);
		await harness.close(context);
	});

	it("marks work admitted after reopen below a cancelled owner whose edge was not loaded", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-durable-ownership-"));
		directories.add(directory);
		const path = join(directory, "session.sqlite");
		let opened = await openHarness(await openNodeSqliteStorage(path));
		const tree = await ownedChild(opened.root, "owner", { slowOwner: true });
		open("owner.inner", "completed");
		await opened.harness.waitForTask(tree.inner, context);
		// 所有者在缓慢执行的中止处理器中仍处于运行且已取消状态。
		await opened.harness.abortTask(tree.owner, context);
		await opened.harness.close(context);

		// 打开时子任务为空，因此在新工作到来前不会加载其依赖边。
		opened = await openHarness(await openNodeSqliteStorage(path));
		const child = (await opened.harness.conversation(tree.child, context))!;
		const late = await child.commit(
			(tx) => tx.createTask(Hold, { name: "late" }, { ownership: { kind: "conversation" } }),
			context,
		);
		expect((await opened.harness.waitForTask(late, context)).state.outcome.status).toBe("aborted");
		open("abort.owner", "completed");
		expect((await opened.harness.waitForTask(tree.owner, context)).state.outcome.status).toBe("aborted");
		await opened.harness.close(context);
	});

	it("cascades from an owner the scheduler orphans", async () => {
		const { harness, root } = await openHarness();
		const { owner, inner } = await root.commit(async (tx) => {
			const owner = await tx.createTask(
				Unregistered,
				{ name: "unregistered" },
				{ ownership: { kind: "conversation" } },
			);
			const child = await tx.createConversation({ ownership: { kind: "task", taskId: owner } });
			return {
				owner,
				inner: await tx.createTask(
					Hold,
					{ name: "below" },
					{ ownership: { kind: "conversation" }, conversationId: child.id },
				),
			};
		}, context);
		expect(await harness.abortTask(owner, context)).toBe("marked");
		expect((await harness.waitForTask(owner, context)).state.outcome).toEqual({
			status: "orphaned",
			reason: "missing_task",
		});
		expect((await harness.waitForTask(inner, context)).state.outcome.status).toBe("aborted");
		await harness.close(context);
	});

	it("cancels only the caller's wait, never the shared work", async () => {
		const { harness, root } = await openHarness();
		const tree = await ownedChild(root, "owner");
		const waiting = new AbortController();
		const idle = root.waitForIdle({ ...context, abortSignal: waiting.signal });
		waiting.abort(new Error("stop waiting"));
		await expect(idle).rejects.toThrow("stop waiting");
		expect((await status(harness, tree.inner)).status).not.toBe("terminal");

		// 中止提交后再取消中止操作，标记仍会保留。
		const slow = await ownedChild(root, "slow");
		await root.commit(async (tx) => {
			const record = (await tx.task(slow.owner))!;
			(tx as unknown as { setTask(value: unknown): void }).setTask({
				...record,
				input: { name: "slow", slowAbort: true },
			});
		}, context);
		const aborting = new AbortController();
		const abort = root.abort({ ...context, abortSignal: aborting.signal });
		await waitUntil(async () => (await harness.getTask(slow.owner, context))!.abortRequested);
		aborting.abort(new Error("stop aborting"));
		await expect(abort).rejects.toThrow("stop aborting");
		open("abort.slow", "completed");
		for (const id of [tree.owner, tree.inner, slow.owner, slow.inner]) {
			expect((await harness.waitForTask(id, context)).state.outcome.status).toBe("aborted");
		}
		await harness.close(context);
	});

	it("aborts a waiting child whose awaited task completes in the commit that marks its owner", async () => {
		const { harness, root } = await openHarness();
		const { owner, dependency, blocked } = await root.commit(async (tx) => {
			const owner = await tx.createTask(Hold, { name: "owner" }, { ownership: { kind: "conversation" } });
			const child = await tx.createConversation({ ownership: { kind: "task", taskId: owner } });
			const dependency = await tx.createTask(Hold, { name: "dependency" }, { ownership: { kind: "conversation" } });
			const blocked = await tx.createTask(
				Waiter,
				{ on: [dependency] },
				{ ownership: { kind: "conversation" }, conversationId: child.id },
			);
			return { owner, dependency, blocked };
		}, context);
		await waitUntil(async () => runs.get("dependency") === 1 && runs.get("owner") === 1);
		await waitUntil(async () => (await status(harness, blocked)).status === "waiting");
		// 一次提交即可完成依赖并标记所有者。
		await root.commit(async (tx) => {
			const setTask = (value: unknown) => (tx as unknown as { setTask(value: unknown): void }).setTask(value);
			const completedDependency = (await tx.task(dependency))!;
			const marked = (await tx.task(owner))!;
			setTask({
				...completedDependency,
				state: { status: "terminal", outcome: { status: "completed", result: null } },
			});
			setTask({ ...marked, abortRequested: true });
		}, context);
		expect((await harness.waitForTask(blocked, context)).state.outcome.status).toBe("aborted");
		await harness.close(context);
	});

	it("applies marks found through an edge loaded after reopen once a failed cascade commit is reopened", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-durable-ownership-"));
		directories.add(directory);
		const path = join(directory, "session.sqlite");
		let opened = await openHarness(await openNodeSqliteStorage(path));
		const tree = await ownedChild(opened.root, "owner", { slowOwner: true });
		open("owner.inner", "completed");
		await opened.harness.waitForTask(tree.inner, context);
		await opened.harness.abortTask(tree.owner, context);
		await opened.harness.close(context);

		const storage = await openNodeSqliteStorage(path);
		let rejectMark: TaskId | undefined;
		const commit = storage.commit.bind(storage);
		storage.commit = async (writes, ctx) => {
			if (
				writes.some((write) => write.type === "task" && write.value.id === rejectMark && write.value.abortRequested)
			) {
				rejectMark = undefined;
				throw new Error("disk gone");
			}
			return commit(writes, ctx);
		};
		opened = await openHarness(storage);
		const child = (await opened.harness.conversation(tree.child, context))!;
		const late = await child.commit(async (tx) => {
			const id = await tx.createTask(Hold, { name: "late" }, { ownership: { kind: "conversation" } });
			rejectMark = id;
			return id;
		}, context);
		// 级联提交失败会导致 Harness 失败。所有调用结束后，`closed` 才会完成；所有者的
		// 中止处理器会忽略其 signal，因此让该处理器自行返回。
		open("abort.owner", "completed");
		expect(await opened.harness.closed).toMatchObject({ reason: "failed" });
		await opened.harness.close(context);
		// 重新打开时会再次派生该标记。
		opened = await openHarness(await openNodeSqliteStorage(path));
		expect((await opened.harness.waitForTask(late, context)).state.outcome.status).toBe("aborted");
		await opened.harness.close(context);
	});

	it("fails the Harness on a failed cascade commit, and reopening applies the cascade", async () => {
		const failure = new Error("disk gone");
		let failMark: TaskId | undefined;
		class Failing extends ControlledStorage {
			override async commit(
				writes: Parameters<MemoryStorage["commit"]>[0],
				ctx: Parameters<MemoryStorage["commit"]>[1],
			) {
				const marks = writes.some(
					(write) => write.type === "task" && write.value.id === failMark && write.value.abortRequested,
				);
				if (marks) {
					failMark = undefined;
					throw failure;
				}
				return super.commit(writes, ctx);
			}
		}
		const storage = new Failing();
		const { harness, root, reports } = await openHarness(storage);
		const tree = await ownedChild(root, "owner");
		failMark = tree.inner;
		open("owner", "failed");
		expect(await harness.closed).toEqual({ reason: "failed", error: failure });
		expect(reports).toEqual([failure]);
		await harness.close(context);
		const reopened = await openHarness(storage.reopen());
		expect((await reopened.harness.waitForTask(tree.inner, context)).state.outcome.status).toBe("aborted");
		await reopened.harness.close(context);
	});
});

describe("owned conversations from tools and supervisors", () => {
	it("gives a tool an invocation-bound handle whose submissions stay durable after the call ends", async () => {
		const setup = chatSetup();
		let handle: ConversationHandle | undefined;
		let missing: ConversationHandle | undefined = {} as ConversationHandle;
		let submission: Submission | undefined;
		addTool(
			setup.registry,
			defineTool({
				name: "delegate",
				description: "Delegates",
				parameters: Type.Object({}),
				execute: async (_args, api, callContext) => {
					const child = await api.commit(async (tx) => {
						const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
						await configure(tx, created.id, { model: { provider: "faux", modelId: "faux-1" } });
						return created.id;
					}, callContext);
					missing = await api.conversation(99_999 as ConversationId, callContext);
					handle = (await api.conversation(child, callContext))!;
					submission = await handle.submit(
						{ type: "input", content: "child task", requestId: "child" },
						callContext,
					);
					const settled = await submission.wait(callContext);
					return { output: [{ type: "text", text: settled.status }] };
				},
			}),
		);
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("delegate", {}, { id: "c1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("child answer")]),
			fauxAssistantMessage([fauxText("done")]),
		]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		expect(missing).toBeUndefined();
		// 调用已结束：句柄和提交都会拒绝，但提交记录仍会保留。
		await expect(handle!.submit({ type: "input", content: "again" }, context)).rejects.toThrow(
			"invocation has ended",
		);
		await expect(handle!.waitForIdle(context)).rejects.toThrow("invocation has ended");
		await expect(handle!.abort(context)).rejects.toThrow("invocation has ended");
		await expect(submission!.wait(context)).rejects.toThrow("invocation has ended");
		// 调用结束后，没有新内容被接纳或标记。
		const childConversation = (await harness.conversation(handle!.id, context))!;
		const childEntries = (await childConversation.entries({}, 100, undefined, context)).items;
		expect(childEntries.filter((entry) => entry.kind === "pi.user")).toHaveLength(1);
		const childTasks = (await harness.inspect(context)).tasks.filter(
			(task) => task.record.conversationId === handle!.id,
		);
		expect(childTasks).toEqual([]);
		expect((await (await harness.submission(submission!.id, context))!.status(context)).status).toBe("done");
		await harness.close(context);
	});

	it("rejects a handle operation queued on the line when the invocation ends before it runs", async () => {
		const setup = chatSetup();
		const ready = deferred<{ child: ConversationId; taskId: TaskId }>();
		const go = deferred();
		const queued = deferred<{ submitting: Promise<unknown> }>();
		addTool(
			setup.registry,
			defineTool({
				name: "delegate",
				description: "Delegates late",
				parameters: Type.Object({}),
				execute: async (_args, api, callContext) => {
					const child = await api.commit(async (tx) => {
						const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
						return created.id;
					}, callContext);
					const handle = (await api.conversation(child, callContext))!;
					ready.resolve({ child, taskId: api.taskId });
					await go.promise;
					// 调用发生时 invocation 仍有效，且传入的 context 不属于该调用：句柄会将其绑定到此
					// invocation。只有在中止标记写入后，调用才会执行到这一行。
					const submitting = handle.submit({ type: "input", content: "late" }, context);
					submitting.catch(() => {});
					queued.resolve({ submitting });
					return aborted(callContext.abortSignal!);
				},
			}),
		);
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("delegate", {}, { id: "c1" })], { stopReason: "toolUse" }),
		]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		await root.submit({ type: "input", content: "go" }, context);
		const { child, taskId } = await ready.promise;
		// 阻塞 Session 队列，将中止标记排在其后，再让工具将提交排队。
		const release = deferred();
		const holding = root.commit(async () => {
			await release.promise;
		}, context);
		const aborting = harness.abortTask(taskId, context);
		go.resolve();
		const { submitting } = await queued.promise;
		release.resolve();
		await holding;
		await aborting;
		await expect(submitting).rejects.toThrow();
		const childConversation = (await harness.conversation(child, context))!;
		expect((await childConversation.entries({}, 10, undefined, context)).items).toEqual([]);
		expect((await harness.inspect(context)).submissions.filter((record) => record.conversationId === child)).toEqual(
			[],
		);
		await harness.close(context);
	});

	it("aborts a subagent run with its parent's conversation, rejecting the waiting tool", async () => {
		const setup = chatSetup();
		let child: ConversationId | undefined;
		const toolWait = deferred<string>();
		addTool(
			setup.registry,
			defineTool({
				name: "delegate",
				description: "Delegates",
				parameters: Type.Object({}),
				execute: async (_args, api, callContext) => {
					child = await api.commit(async (tx) => {
						const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
						await configure(tx, created.id, { model: { provider: "faux", modelId: "faux-1" } });
						return created.id;
					}, callContext);
					const submission = await (await api.conversation(child, callContext))!.submit(
						{ type: "input", content: "child task" },
						callContext,
					);
					try {
						return { output: [{ type: "text", text: (await submission.wait(callContext)).status }] };
					} catch (error) {
						toolWait.resolve((error as Error).message);
						throw error;
					}
				},
			}),
		);
		const childRun = gated(fauxAssistantMessage([fauxText("never")]));
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("delegate", {}, { id: "c1" })], { stopReason: "toolUse" }),
			childRun.step,
		]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const input = await root.submit({ type: "input", content: "go" }, context);
		await childRun.reached;
		await root.abort(context);
		expect(await input.wait(context)).toMatchObject({ status: "unanswered", reason: "aborted" });
		expect(await toolWait.promise).toBeTruthy();
		const childConversation = (await harness.conversation(child!, context))!;
		await childConversation.waitForIdle(context);
		const childLive = await harness.snapshot(LiveDoc, child!, context);
		expect(childLive).toEqual({});
		const childInputs = (await harness.inspect(context)).submissions.filter((s) => s.conversationId === child);
		expect(childInputs).toEqual([]);
		await harness.waitForIdle(context);
		await harness.close(context);
	});

	it("lets a running tool abort its owned child and continue", async () => {
		const setup = chatSetup();
		const childRun = gated(fauxAssistantMessage([fauxText("never")]));
		addTool(
			setup.registry,
			defineTool({
				name: "delegate",
				description: "Delegates and cancels",
				parameters: Type.Object({}),
				execute: async (_args, api, callContext) => {
					const child = await api.commit(async (tx) => {
						const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
						await configure(tx, created.id, { model: { provider: "faux", modelId: "faux-1" } });
						return created.id;
					}, callContext);
					const handle = (await api.conversation(child, callContext))!;
					const submission = await handle.submit({ type: "input", content: "child task" }, callContext);
					await childRun.reached;
					await handle.abort(callContext);
					const settledChild = await submission.wait(callContext);
					return { output: [{ type: "text", text: `child ${settledChild.status}` }] };
				},
			}),
		);
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("delegate", {}, { id: "c1" })], { stopReason: "toolUse" }),
			childRun.step,
			fauxAssistantMessage([fauxText("done")]),
		]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		expect((await (await root.submit({ type: "input", content: "go" }, context)).wait(context)).status).toBe("done");
		await harness.close(context);
	});

	it("aborts the children of a tool call that throws or is interrupted, while the run continues", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-durable-tool-children-"));
		directories.add(directory);
		const path = join(directory, "session.sqlite");
		const children: TaskId[] = [];
		const toolRunning = deferred();
		const setup = chatSetup();
		addTask(setup.registry, Hold);
		addTool(
			setup.registry,
			defineTool({
				name: "spawn",
				description: "Starts owned work, then throws or hangs",
				parameters: Type.Object({ mode: Type.String() }),
				execute: async (args, api, callContext) => {
					const child = await api.commit(async (tx) => {
						const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
						return tx.createTask(
							Hold,
							{ name: `child.${api.callId}` },
							{ ownership: { kind: "conversation" }, conversationId: created.id },
						);
					}, callContext);
					children.push(child);
					if (args.mode === "throw") throw new Error("spawn failed");
					toolRunning.resolve();
					return aborted(callContext.abortSignal!);
				},
			}),
		);
		const call = (mode: string, id: string) =>
			fauxAssistantMessage([fauxToolCall("spawn", { mode }, { id })], { stopReason: "toolUse" });
		setup.faux.setResponses([
			call("throw", "c1"),
			fauxAssistantMessage([fauxText("after throw")]),
			call("hang", "c2"),
		]);
		let opened = await openChat(await openNodeSqliteStorage(path), setup);
		expect((await (await opened.root.submit({ type: "input", content: "one" }, context)).wait(context)).status).toBe(
			"done",
		);
		expect((await opened.harness.waitForTask(children[0]!, context)).state.outcome.status).toBe("aborted");

		// 第二次调用会一直挂起到进程停止；重新打开时会中断该调用。
		const second = (await opened.root.submit({ type: "input", content: "two" }, context)).id;
		await toolRunning.promise;
		await opened.harness.close(context);
		setup.faux.setResponses([fauxAssistantMessage([fauxText("after interrupt")])]);
		opened = await openChat(await openNodeSqliteStorage(path), setup);
		opened.harness.resume();
		expect((await opened.harness.waitForTask(children[1]!, context)).state.outcome.status).toBe("aborted");
		expect((await (await opened.harness.submission(second, context))!.wait(context)).status).toBe("done");
		const tools = (await opened.harness.commit((tx) => tx.scanTasks({ kind: "pi.tool" }, 10), context)).items;
		expect(tools.map((task) => task.state.status === "terminal" && task.state.outcome.status)).toEqual([
			"failed",
			"failed",
		]);
		await opened.harness.close(context);
	});

	it("reruns a replay-safe subagent tool after a restart with the same child and submission", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-durable-safe-subagent-"));
		directories.add(directory);
		const path = join(directory, "session.sqlite");
		const children: ConversationId[] = [];
		const setup = chatSetup();
		addTool(
			setup.registry,
			defineTool({
				name: "subagent",
				description: "Delegates",
				parameters: Type.Object({}),
				replay: "safe",
				execute: async (_args, api, callContext) => {
					const child = await api.commit(async (tx) => {
						const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
						if (existing !== undefined) return existing.id;
						const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
						await configure(tx, created.id, { model: { provider: "faux", modelId: "faux-1" } });
						return created.id;
					}, callContext);
					children.push(child);
					const request = { type: "input", content: "child task", requestId: `subagent:${api.taskId}` } as const;
					const submission = await (await api.conversation(child, callContext))!.submit(request, callContext);
					const settled = await submission.wait(callContext);
					return { output: [{ type: "text", text: settled.status }] };
				},
			}),
		);
		const childRun = gated(fauxAssistantMessage([fauxText("never")]));
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("subagent", {}, { id: "c1" })], { stopReason: "toolUse" }),
			childRun.step,
		]);
		let opened = await openChat(await openNodeSqliteStorage(path), setup);
		const input = (await opened.root.submit({ type: "input", content: "go" }, context)).id;
		await childRun.reached;
		await opened.harness.close(context);

		setup.faux.setResponses([
			fauxAssistantMessage([fauxText("child answer")]),
			fauxAssistantMessage([fauxText("done")]),
		]);
		opened = await openChat(await openNodeSqliteStorage(path), setup);
		expect((await (await opened.harness.submission(input, context))!.wait(context)).status).toBe("done");
		expect(children).toHaveLength(2);
		expect(children[1]).toBe(children[0]);
		const child = (await opened.harness.conversation(children[0]!, context))!;
		const entries = (await child.entries({}, 100, undefined, context)).items;
		expect(entries.filter((entry) => entry.kind === "pi.user")).toHaveLength(1);
		const results = (await opened.root.context(context)).messages.filter((message) => message.role === "toolResult");
		expect(results.map((message) => message.isError)).toEqual([false]);
		await opened.harness.close(context);
	});

	it("lets a background supervisor resubmit after a restart without submitting twice", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-durable-supervisor-"));
		directories.add(directory);
		const path = join(directory, "session.sqlite");
		const Children = defineDoc<{ child?: ConversationId }>({
			kind: "test.children",
			version: 1,
			scope: "conversation",
			history: "latest",
			fork: "initial",
			initial: () => ({}),
		});
		const Supervisor = defineTask<{ parent: ConversationId }, { phase: "run" }, { answer: EntryId }>({
			name: "test.supervisor",
			version: 1,
			initial: () => ({ phase: "run" }),
			phases: {
				run: async (task, runtime, ctx) => {
					const id = (await runtime.snapshot(Children, task.input.parent, ctx))!.child!;
					const child = (await runtime.conversation(id, ctx))!;
					const submission = await child.submit({ type: "input", content: "work", requestId: "stable" }, ctx);
					const settled = await submission.wait(ctx);
					if (settled.status !== "done" || settled.type !== "input") throw new Error(settled.status);
					await runtime.commit(
						() => ({ status: "terminal", outcome: { status: "completed", result: { answer: settled.answer } } }),
						ctx,
					);
				},
			},
			abort: (_task, runtime, ctx) =>
				runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
		});
		const setup = chatSetup();
		addTask(setup.registry, Supervisor);
		const first = gated(fauxAssistantMessage([fauxText("never")]));
		setup.faux.setResponses([first.step, fauxAssistantMessage([fauxText("answer")])]);
		let opened = await openChat(await openNodeSqliteStorage(path), setup);
		const root = opened.root;
		const { supervisor, child } = await root.commit(async (tx) => {
			const supervisor = await tx.createTask(
				Supervisor,
				{ parent: root.id },
				{ ownership: { kind: "conversation" }, background: true },
			);
			const created = await tx.createConversation({ ownership: { kind: "task", taskId: supervisor } });
			await configure(tx, created.id, { model: { provider: "faux", modelId: "faux-1" } });
			(await tx.doc(Children, root.id)).child = created.id;
			return { supervisor, child: created.id };
		}, context);
		opened.harness.resume();
		// 提交已被接纳并开始请求生成；随后进程停止。
		await first.reached;
		await opened.harness.close(context);

		opened = await openChat(await openNodeSqliteStorage(path), setup);
		opened.harness.resume();
		const done = await opened.harness.waitForTask(supervisor, context);
		expect(done.state.outcome.status).toBe("completed");
		const childConversation = (await opened.harness.conversation(child, context))!;
		const entries = (await childConversation.entries({}, 100, undefined, context)).items;
		expect(entries.filter((entry) => entry.kind === "pi.user")).toHaveLength(1);
		// 根任务从未等待后台监控器。
		await opened.root.waitForIdle(context);
		await opened.harness.close(context);
	});
});
