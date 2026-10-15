import type { Context } from "@earendil-works/chord";
import { createModels, type Message } from "@earendil-works/pi-ai";
import {
	type ContextView,
	createRegistry,
	defineTask,
	type EntryDraft,
	type EntryId,
	type EntryRecord,
	Harness,
	type HarnessSettings,
	MemoryStorage,
	type Storage,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addTask, assistant, describeMessage, openHarness, system, toolResult, user } from "./harness-support.ts";
import { context } from "./session-support.ts";

async function setup() {
	const { harness } = await openHarness(new MemoryStorage());
	const root = await harness.root(context);
	const append = (draft: EntryDraft): Promise<EntryRecord> =>
		root.commit((tx) => tx.appendEntry(root.id, draft), context);
	const message = (model: Message, kind = "message"): Promise<EntryRecord> => append({ kind, model: [model] });
	return { harness, root, append, message };
}

/** 使用 MemoryStorage 并统计扫描条目数的 Harness，根会话记录包含 21 个条目。 */
async function countingSetup(options: { readonly settings?: HarnessSettings; readonly now?: () => number } = {}) {
	const scanned = { rows: 0 };
	/** 设置后，下一次范围扫描会等待此门闩；边界探测（单行且在 Session 队列中执行）不受影响。 */
	const hold: { scan?: Promise<void> } = {};
	const memory = new MemoryStorage();
	const storage = new Proxy<Storage>(memory, {
		get(target, key) {
			const value: unknown = Reflect.get(target, key, target);
			if (key === "scanEntries") {
				return async (...args: Parameters<Storage["scanEntries"]>) => {
					const held = args[1] > 1 ? hold.scan : undefined;
					if (held !== undefined) hold.scan = undefined;
					await held;
					const page = await target.scanEntries(...args);
					scanned.rows += page.items.length;
					return page;
				};
			}
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const registry = createRegistry();
	const harness = await Harness.open(storage, { models: createModels(), registry, ...options }, context);
	const root = await harness.root(context);
	const first = await root.commit(
		(tx) => tx.appendEntry(root.id, { kind: "message", model: [user("first")] }),
		context,
	);
	for (let index = 0; index < 20; index++) {
		await root.commit(
			(tx) => tx.appendEntry(root.id, { kind: "message", model: [assistant(`old ${index}`)] }),
			context,
		);
	}
	return { harness, registry, root, first, scanned, hold };
}

function ids(entries: readonly EntryRecord[]): EntryId[] {
	return entries.map((entry) => entry.id);
}

afterEach(() => {
	vi.useRealTimers();
});

describe("conversation context", () => {
	it("returns the whole transcript without a head and excludes model-less entries from messages", async () => {
		const { root, append, message } = await setup();
		const first = await message(user("hi"));
		const note = await append({ kind: "note", data: { text: "display only" } });
		const answer = await message(assistant("hello"));
		const view = await root.context(context);
		expect(view.head).toBeUndefined();
		expect(ids(view.entries)).toEqual([first.id, note.id, answer.id]);
		expect(view.messages.map(describeMessage)).toEqual(["user:hi", "assistant:hello"]);
	});

	it("excludes aborted, error, and deferred assistant messages but keeps their raw entries", async () => {
		const { root, message } = await setup();
		await message(user("q"));
		const aborted = await message(assistant("partial", { stopReason: "aborted" }));
		await message(assistant("failed", { stopReason: "error" }));
		await message(assistant("later", { stopReason: "deferred" }));
		await message(assistant("done", { stopReason: "length" }));
		const view = await root.context(context);
		expect(view.entries).toHaveLength(5);
		expect(view.entries[1]!.id).toBe(aborted.id);
		expect(view.messages.map(describeMessage)).toEqual(["user:q", "assistant:done"]);
	});

	it("resolves self heads and uses the newest head marker", async () => {
		const { root, append, message } = await setup();
		await message(user("old"));
		const reset = await append({ kind: "reset", head: "self", model: [user("fresh start")] });
		expect(reset.head).toBe(reset.id);
		const after = await message(assistant("after reset"));
		let view = await root.context(context);
		expect(view.head?.id).toBe(reset.id);
		expect(ids(view.entries)).toEqual([reset.id, after.id]);
		expect(view.messages.map(describeMessage)).toEqual(["user:fresh start", "assistant:after reset"]);

		// 压缩摘要位于较早的保留条目前面；范围内更旧的起始标记会被排除。
		const summary = await append({ kind: "summary", head: after.id, model: [user("summary")] });
		const tail = await message(user("next"));
		view = await root.context(context);
		expect(view.head?.id).toBe(summary.id);
		expect(ids(view.entries)).toEqual([summary.id, after.id, tail.id]);
		expect(view.messages.map(describeMessage)).toEqual(["user:summary", "assistant:after reset", "user:next"]);
	});

	it("applies the newest edit per target within the active range", async () => {
		const { root, append, message } = await setup();
		const first = await message(user("first"));
		const second = await message(user("second"));
		await append({ kind: "edit", edits: [{ target: first.id, action: "replace", messages: [user("first v2")] }] });
		await append({ kind: "edit", edits: [{ target: first.id, action: "replace", messages: [user("first v3")] }] });
		await append({ kind: "edit", edits: [{ target: second.id, action: "omit" }] });
		let view = await root.context(context);
		expect(view.entries).toHaveLength(5);
		expect(view.messages.map(describeMessage)).toEqual(["user:first v3"]);

		// 活动范围之前的编辑不再生效。
		const reset = await append({ kind: "reset", head: second.id });
		view = await root.context(context);
		expect(view.head?.id).toBe(reset.id);
		expect(view.messages.map(describeMessage)).toEqual([]);
		await append({ kind: "edit", edits: [{ target: second.id, action: "replace", messages: [user("second v2")] }] });
		view = await root.context(context);
		expect(view.messages.map(describeMessage)).toEqual(["user:second v2"]);
	});

	it("keeps positional system messages and orders tool results by call order", async () => {
		const { root, message, append } = await setup();
		await message(system({ preamble: "You help." }), "pi.system");
		await message(user("run tools"));
		await message(assistant("calling", { calls: ["b", "a"] }));
		await message(toolResult("a"));
		await append({ kind: "pi.system", model: [system({ cwd: "/repo" })] });
		await message(toolResult("b"));
		await message(toolResult("zz"));
		await message(assistant("done"));
		const view = await root.context(context);
		expect(view.messages.map(describeMessage)).toEqual([
			"system:preamble",
			"user:run tools",
			"assistant:calling",
			"result:b:result b",
			"result:a:result a",
			"system:cwd",
			"assistant:done",
		]);
	});

	// #10542
	it("leads with a system message that only user messages precede, and keeps later ones in place", async () => {
		const { root, message, append } = await setup();
		await message(user("first"));
		await message(user("steered"));
		await message(system({ preamble: "You help." }), "pi.system");
		await message(assistant("answer"));
		await message(user("next"));
		await message(system({ cwd: "/repo" }), "pi.system");
		let view = await root.context(context);
		expect(view.messages.map(describeMessage)).toEqual([
			"system:preamble",
			"user:first",
			"user:steered",
			"assistant:answer",
			"user:next",
			"system:cwd",
		]);
		// 已存储的顺序和贡献内容保持提交时的状态。
		expect(view.contributions.flat().map(describeMessage).slice(0, 3)).toEqual([
			"user:first",
			"user:steered",
			"system:preamble",
		]);

		// 重置后，交接之后写入的基线也会成为开头。
		await append({ kind: "reset", head: "self", model: [user("handoff")] });
		await message(system({ preamble: "Baseline." }), "pi.system");
		view = await root.context(context);
		expect(view.messages.map(describeMessage)).toEqual(["system:preamble", "user:handoff"]);
	});

	it("synthesizes missing tool results after a fork and drops results cut from their call", async () => {
		const { root, message } = await setup();
		await message(user("go"));
		const call = await message(assistant("calling", { calls: ["x", "y"] }));
		await message(toolResult("x"));
		const second = await message(toolResult("y"));
		const child = await root.fork(call.id, { ownership: { kind: "ownerless" } }, context);
		const childView = await child.context(context);
		expect(childView.messages.map(describeMessage)).toEqual([
			"user:go",
			"assistant:calling",
			"result:x:error",
			"result:y:error",
		]);
		const missing = childView.messages[2]!;
		expect(missing).toMatchObject({
			role: "toolResult",
			toolName: "tool-x",
			details: { reason: "missing_result" },
		});

		// 起始标记若位于调用与其结果之间，这些游离结果不会被发送。
		await root.commit((tx) => tx.appendEntry(root.id, { kind: "reset", head: second.id }), context);
		const parentView = await root.context(context);
		expect(parentView.messages.map(describeMessage)).toEqual([]);
		expect(parentView.entries.map((entry) => entry.kind)).toEqual(["reset", "message"]);
	});

	// #10512
	it("reads the context as of an earlier entry, as a fork at that entry starts", async () => {
		const { root, append, message } = await setup();
		const first = await message(user("first"));
		const call = await message(assistant("calling", { calls: ["x", "y"] }));
		const result = await message(toolResult("x"));
		await message(toolResult("y"));
		const edit = await append({
			kind: "edit",
			edits: [{ target: first.id, action: "replace", messages: [user("first v2")] }],
		});
		const reset = await append({ kind: "reset", head: "self", model: [user("fresh start")] });
		const tail = await message(assistant("after reset"));

		for (const at of [first, call, result, edit, reset, tail]) {
			const fork = await root.fork(at.id, { ownership: { kind: "ownerless" } }, context);
			expect(await root.context(context, { at: at.id })).toEqual(await fork.context(context));
		}
		// 回退到编辑和重置之前：两者都不生效，被截断的调用会获得合成结果。
		expect((await root.context(context, { at: call.id })).messages.map(describeMessage)).toEqual([
			"user:first",
			"assistant:calling",
			"result:x:error",
			"result:y:error",
		]);
		expect(await root.context(context, { at: tail.id })).toEqual(await root.context(context));
		expect(await root.context(context, {})).toEqual(await root.context(context));

		const other = await root.fork(first.id, { ownership: { kind: "ownerless" } }, context);
		await expect(other.context(context, { at: tail.id })).rejects.toThrow("is not visible");
	});

	it("extends a task's context read with only newer entries", async () => {
		const { harness, registry, root, first, scanned } = await countingSetup();
		const Reads = defineTask<Record<string, never>, { phase: "run" }, null>({
			name: "test.context-reads",
			version: 1,
			initial: () => ({ phase: "run" }),
			phases: {
				run: async (_task, runtime, taskContext) => {
					const write = (draft: EntryDraft) =>
						runtime.commit(async (tx) => {
							await tx.appendEntry(root.id, draft);
							return undefined;
						}, taskContext);
					const read = async (at?: EntryId): Promise<{ view: ContextView; rows: number }> => {
						const before = scanned.rows;
						const view = await runtime.context(root.id, taskContext, { at });
						return { view, rows: scanned.rows - before };
					};
					const initial = await read();
					expect(initial.view).toEqual(await root.context(taskContext));

					// 新增了三个条目：边界探测读取一行，扩展读取这三个新条目。
					await write({ kind: "message", model: [user("new")] });
					await write({ kind: "note", data: { text: "display only" } });
					await write({ kind: "message", model: [assistant("answer")] });
					const extended = await read();
					expect(extended.rows).toBe(4);
					expect(extended.view).toEqual(await root.context(taskContext));

					// 对旧条目的较新编辑会应用到扩展后的范围。
					await write({ kind: "edit", edits: [{ target: first.id, action: "omit" }] });
					const edited = await read();
					expect(edited.rows).toBe(2);
					expect(edited.view).toEqual(await root.context(taskContext));
					expect(edited.view.messages.map(describeMessage)).not.toContain("user:first");

					// 截止点提前时会复用该范围。
					const cutoff = await read(extended.view.entries.at(-1)!.id);
					expect(cutoff.rows).toBe(0);
					expect(cutoff.view).toEqual(extended.view);

					// 新的起始标记会改变范围，因此需要完整读取。
					await write({ kind: "reset", head: "self", model: [user("fresh")] });
					const reset = await read();
					expect(reset.view).toEqual(await root.context(taskContext));
					expect(reset.view.messages.map(describeMessage)).toEqual(["user:fresh"]);

					await runtime.commit(
						() => ({ status: "terminal", outcome: { status: "completed", result: null } }),
						taskContext,
					);
				},
			},
			abort: async (_task, runtime, taskContext) => {
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext);
			},
		});
		addTask(registry, Reads);
		const id = await harness.commit(
			(tx) => tx.createTask(Reads, {}, { ownership: { kind: "conversation" }, conversationId: root.id }),
			context,
		);
		harness.resume();
		const settled = await harness.waitForTask(id, context);
		expect(settled.state.outcome).toEqual({ status: "completed", result: null });
		await harness.close(context);
	});

	it("keeps a conversation's context read across its tasks and for the retention period once idle", async () => {
		let clock = 1_000;
		const { harness, registry, root, scanned } = await countingSetup({ now: () => clock });
		const rows: Record<string, number> = {};
		const read = async (name: string, load: () => Promise<ContextView>, taskContext: Context) => {
			const before = scanned.rows;
			const view = await load();
			rows[name] = scanned.rows - before;
			expect(view).toEqual(await root.context(taskContext));
		};
		const Child = defineTask<Record<string, never>, { phase: "run" }, null>({
			name: "test.context-child",
			version: 1,
			initial: () => ({ phase: "run" }),
			phases: {
				run: async (_task, runtime, taskContext) => {
					await runtime.commit(async (tx) => {
						await tx.appendEntry(root.id, { kind: "message", model: [user("from child")] });
						return undefined;
					}, taskContext);
					await read("child", () => runtime.context(root.id, taskContext), taskContext);
					await runtime.commit(() => DONE, taskContext);
				},
			},
			abort: async (_task, runtime, taskContext) => {
				await runtime.commit(() => ABORTED, taskContext);
			},
		});
		const Parent = defineTask<Record<string, never>, { phase: "start" } | { phase: "after" }, null>({
			name: "test.context-parent",
			version: 1,
			initial: () => ({ phase: "start" }),
			phases: {
				start: async (_task, runtime, taskContext) => {
					await read("parent", () => runtime.context(root.id, taskContext), taskContext);
					await runtime.commit(async (tx) => {
						const child = await tx.createTask(
							Child,
							{},
							{ ownership: { kind: "task", taskId: runtime.taskId }, conversationId: root.id },
						);
						return { status: "waiting", checkpoint: { phase: "after" }, on: [child], policy: "allSettled" };
					}, taskContext);
				},
				after: async (_task, runtime, taskContext) => {
					await read("after", () => runtime.context(root.id, taskContext), taskContext);
					await runtime.commit(() => DONE, taskContext);
				},
			},
			abort: async (_task, runtime, taskContext) => {
				await runtime.commit(() => ABORTED, taskContext);
			},
		});
		const Probe = probeTask(read);
		for (const task of [Child, Parent, Probe]) addTask(registry, task);
		harness.resume();
		const options = { ownership: { kind: "conversation" }, conversationId: root.id } as const;
		const parent = await harness.commit((tx) => tx.createTask(Parent, {}, options), context);
		expect((await harness.waitForTask(parent, context)).state.outcome).toEqual(DONE.outcome);
		await root.waitForIdle(context);
		const probe = async (name: string) => {
			const id = await harness.commit((tx) => tx.createTask(Probe, { name }, options), context);
			expect((await harness.waitForTask(id, context)).state.outcome).toEqual(DONE.outcome);
			await root.waitForIdle(context);
		};
		await probe("idle");
		clock += 600_000;
		await probe("expired");
		// 每次边界探测都读取一行。子对话扫描自身新增的条目；等待中的父对话后续调用以及保留期内的探测都不会扫描新内容。
		// 超过保留期后，探测会再次读取整个会话文本。
		expect(rows).toEqual({ parent: 22, child: 2, after: 1, idle: 1, expired: 23 });
		await harness.close(context);
	});

	it("derives the same view from extended reads as from whole reads", async () => {
		const { harness, registry, root } = await countingSetup();
		// 使用确定性伪随机方式生成会话文本（32 位 LCG，取高位），涵盖任意顺序的调用和结果、缺失或多余的结果、
		// 排除的停止原因、系统条目、备注、对早期条目的编辑，以及头部标记。
		let seed = 7;
		const random = (n: number) => {
			seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
			return Math.floor((seed / 2 ** 32) * n);
		};
		const seen = new Map<string, number>();
		const count = (category: string) => seen.set(category, (seen.get(category) ?? 0) + 1);
		const Steps = defineTask<Record<string, never>, { phase: "run" }, null>({
			name: "test.context-steps",
			version: 1,
			initial: () => ({ phase: "run" }),
			phases: {
				run: async (_task, runtime, taskContext) => {
					const written: EntryRecord[] = [];
					const calls: string[] = [];
					let next = 0;
					const draft = (): EntryDraft => {
						const pick = random(14);
						if (pick < 3) {
							count("user");
							return { kind: "message", model: [user(`u${next++}`)] };
						}
						if (pick < 5) {
							const ids = Array.from({ length: random(3) }, () => `c${next++}`);
							calls.push(...ids);
							const stopReason = (["aborted", "error", "deferred"] as const)[random(9)];
							count(stopReason ?? "assistant");
							return {
								kind: "message",
								model: [assistant(`a${next++}`, { calls: ids, ...(stopReason ? { stopReason } : {}) })],
							};
						}
						if (pick < 8) {
							const matched = calls.length > 0 && random(5) > 0;
							count(matched ? "result" : "stray result");
							const id = matched ? calls.splice(random(calls.length), 1)[0]! : `stray${next++}`;
							return { kind: "message", model: [toolResult(id)] };
						}
						if (pick < 9) {
							count("system");
							return { kind: "message", model: [system({ s: `v${next++}` })] };
						}
						if (pick < 10) {
							count("note");
							return { kind: "note", data: { n: next++ } };
						}
						const target = written[random(written.length)];
						if (pick < 12 && target !== undefined) {
							const omit = random(2) === 0;
							count(omit ? "omit" : "replace");
							const action = omit
								? { action: "omit" as const }
								: { action: "replace" as const, messages: [user(`r${next++}`)] };
							return { kind: "edit", edits: [{ target: target.id, ...action }] };
						}
						if (pick < 13 && target !== undefined) {
							count("head");
							return { kind: "summary", head: target.id, model: [user(`h${next++}`)] };
						}
						count("user");
						return { kind: "message", model: [user(`u${next++}`)] };
					};
					const append = (conversationId: typeof root.id) =>
						runtime.commit(async (tx) => {
							const added = 1 + random(3);
							for (let index = 0; index < added; index++) {
								written.push(await tx.appendEntry(conversationId, draft()));
							}
							return undefined;
						}, taskContext);
					for (let step = 0; step < 150; step++) {
						await append(root.id);
						expect(await runtime.context(root.id, taskContext)).toEqual(await root.context(taskContext));
						if (step % 10 === 9) {
							// 相互重叠的读取（其中一次的截止位置更早）共用保留范围。
							const at = written[random(written.length)]!.id;
							const [whole, cut] = await Promise.all([
								runtime.context(root.id, taskContext),
								runtime.context(root.id, taskContext, { at }),
							]);
							expect(whole).toEqual(await root.context(taskContext));
							expect(cut).toEqual(await root.context(taskContext, { at }));
						}
					}
					// 分支会看到父会话截至分叉点的条目，并接续自身的条目。
					const fork = await root.fork(
						written[random(written.length)]!.id,
						{ ownership: { kind: "ownerless" } },
						taskContext,
					);
					for (let step = 0; step < 20; step++) {
						expect(await runtime.context(fork.id, taskContext)).toEqual(await fork.context(taskContext));
						await append(fork.id);
					}
					await runtime.commit(() => DONE, taskContext);
				},
			},
			abort: async (_task, runtime, taskContext) => {
				await runtime.commit(() => ABORTED, taskContext);
			},
		});
		addTask(registry, Steps);
		harness.resume();
		const id = await harness.commit(
			(tx) => tx.createTask(Steps, {}, { ownership: { kind: "conversation" }, conversationId: root.id }),
			context,
		);
		expect((await harness.waitForTask(id, context)).state.outcome).toEqual(DONE.outcome);
		const categories = [
			"user",
			"assistant",
			"aborted",
			"error",
			"deferred",
			"result",
			"stray result",
			"system",
			"note",
		];
		for (const category of [...categories, "omit", "replace", "head"]) expect(seen.get(category)).toBeGreaterThan(0);
		await harness.close(context);
	});

	it("keeps returned views and kept ranges apart", async () => {
		const { harness, registry, root } = await countingSetup();
		const Mutate = defineTask<Record<string, never>, { phase: "run" }, null>({
			name: "test.context-mutate",
			version: 1,
			initial: () => ({ phase: "run" }),
			phases: {
				run: async (_task, runtime, taskContext) => {
					const view = await runtime.context(root.id, taskContext);
					(view.messages as Message[]).length = 0;
					(view.entries as EntryRecord[]).pop();
					// 保留的条目与 MemoryStorage 记录一样被冻结。
					expect(() => {
						(view.contributions[0]![0] as { content: unknown }).content = "changed";
					}).toThrow(TypeError);
					expect(await runtime.context(root.id, taskContext)).toEqual(await root.context(taskContext));
					await runtime.commit(() => DONE, taskContext);
				},
			},
			abort: async (_task, runtime, taskContext) => {
				await runtime.commit(() => ABORTED, taskContext);
			},
		});
		addTask(registry, Mutate);
		harness.resume();
		const id = await harness.commit(
			(tx) => tx.createTask(Mutate, {}, { ownership: { kind: "conversation" }, conversationId: root.id }),
			context,
		);
		expect((await harness.waitForTask(id, context)).state.outcome).toEqual(DONE.outcome);
		await harness.close(context);
	});

	it("freezes kept entries deeply even when storage freezes them shallowly", async () => {
		const memory = new MemoryStorage();
		// 创建新副本且只冻结记录本身；其中的消息仍可修改。
		const storage = new Proxy<Storage>(memory, {
			get(target, key) {
				const value: unknown = Reflect.get(target, key, target);
				if (key === "scanEntries") {
					return async (...args: Parameters<Storage["scanEntries"]>) => {
						const page = await target.scanEntries(...args);
						return { ...page, items: page.items.map((item) => Object.freeze(structuredClone(item))) };
					};
				}
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const registry = createRegistry();
		const harness = await Harness.open(storage, { models: createModels(), registry }, context);
		const root = await harness.root(context);
		await root.commit((tx) => tx.appendEntry(root.id, { kind: "message", model: [user("hello")] }), context);
		const Mutate = defineTask<Record<string, never>, { phase: "run" }, null>({
			name: "test.context-shallow",
			version: 1,
			initial: () => ({ phase: "run" }),
			phases: {
				run: async (_task, runtime, taskContext) => {
					const view = await runtime.context(root.id, taskContext);
					expect(() => {
						(view.messages[0] as { content: unknown }).content = "changed";
					}).toThrow(TypeError);
					await runtime.commit(() => DONE, taskContext);
				},
			},
			abort: async (_task, runtime, taskContext) => {
				await runtime.commit(() => ABORTED, taskContext);
			},
		});
		addTask(registry, Mutate);
		harness.resume();
		const id = await harness.commit(
			(tx) => tx.createTask(Mutate, {}, { ownership: { kind: "conversation" }, conversationId: root.id }),
			context,
		);
		expect((await harness.waitForTask(id, context)).state.outcome).toEqual(DONE.outcome);
		await harness.close(context);
	});

	it("does not keep a read that finishes after its task ended", async () => {
		const { harness, registry, root, scanned, hold } = await countingSetup({ settings: { contextRetentionMs: 0 } });
		const scans = Promise.withResolvers<void>();
		const probeStart = Promise.withResolvers<void>();
		let late: Promise<unknown> | undefined;
		const Late = defineTask<Record<string, never>, { phase: "run" }, null>({
			name: "test.context-late",
			version: 1,
			initial: () => ({ phase: "run" }),
			phases: {
				run: async (_task, runtime, taskContext) => {
					hold.scan = scans.promise;
					late = runtime.context(root.id, taskContext).catch((error: unknown) => error);
					await runtime.commit(() => DONE, taskContext);
				},
			},
			abort: async (_task, runtime, taskContext) => {
				await runtime.commit(() => ABORTED, taskContext);
			},
		});
		const rows: Record<string, number> = {};
		const Probe = probeTask(async (name, load) => {
			await probeStart.promise;
			const before = scanned.rows;
			await load();
			rows[name] = scanned.rows - before;
		});
		for (const task of [Late, Probe]) addTask(registry, task);
		harness.resume();
		const options = { ownership: { kind: "conversation" }, conversationId: root.id } as const;
		const lateId = await harness.commit((tx) => tx.createTask(Late, {}, options), context);
		expect((await harness.waitForTask(lateId, context)).state.outcome).toEqual(DONE.outcome);
		// 延迟读取结束时会话再次处于忙碌状态，因此不能保留该范围。
		const probeId = await harness.commit((tx) => tx.createTask(Probe, { name: "probe" }, options), context);
		scans.resolve();
		await late;
		probeStart.resolve();
		expect((await harness.waitForTask(probeId, context)).state.outcome).toEqual(DONE.outcome);
		expect(rows).toEqual({ probe: 22 });
		await harness.close(context);
	});

	it("drops an idle conversation's context read on a timer when nothing else runs", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		const { harness, registry, root, scanned } = await countingSetup({ settings: { contextRetentionMs: 1_000 } });
		const rows: Record<string, number> = {};
		const Probe = probeTask(async (name, load) => {
			const before = scanned.rows;
			await load();
			rows[name] = scanned.rows - before;
		});
		addTask(registry, Probe);
		harness.resume();
		const options = { ownership: { kind: "conversation" }, conversationId: root.id } as const;
		const probe = async (name: string) => {
			const id = await harness.commit((tx) => tx.createTask(Probe, { name }, options), context);
			expect((await harness.waitForTask(id, context)).state.outcome).toEqual(DONE.outcome);
			await root.waitForIdle(context);
		};
		const idle = vi.getTimerCount();
		await probe("first");
		expect(vi.getTimerCount()).toBe(idle + 1);
		vi.advanceTimersByTime(1_000);
		expect(vi.getTimerCount()).toBe(idle);
		await probe("second");
		expect(rows).toEqual({ first: 22, second: 22 });
		await harness.close(context);
	});

	it("drops a conversation's context read once idle with zero retention", async () => {
		const { harness, registry, root, scanned } = await countingSetup({ settings: { contextRetentionMs: 0 } });
		const rows: Record<string, number> = {};
		const Probe = probeTask(async (name, load) => {
			const before = scanned.rows;
			await load();
			rows[name] = scanned.rows - before;
		});
		addTask(registry, Probe);
		harness.resume();
		const options = { ownership: { kind: "conversation" }, conversationId: root.id } as const;
		for (const name of ["first", "second"]) {
			const id = await harness.commit((tx) => tx.createTask(Probe, { name }, options), context);
			expect((await harness.waitForTask(id, context)).state.outcome).toEqual(DONE.outcome);
			await root.waitForIdle(context);
		}
		expect(rows).toEqual({ first: 22, second: 22 });
		await harness.close(context);
	});
});

const DONE = { status: "terminal", outcome: { status: "completed", result: null } } as const;

const ABORTED = { status: "terminal", outcome: { status: "aborted" } } as const;

/** 读取一次所属会话上下文的任务，其名称由输入指定。 */
function probeTask(read: (name: string, load: () => Promise<ContextView>, taskContext: Context) => Promise<void>) {
	return defineTask<{ name: string }, { phase: "run" }, null>({
		name: "test.context-probe",
		version: 1,
		initial: () => ({ phase: "run" }),
		phases: {
			run: async (task, runtime, taskContext) => {
				await read(task.input.name, () => runtime.context(runtime.conversationId, taskContext), taskContext);
				await runtime.commit(() => DONE, taskContext);
			},
		},
		abort: async (_task, runtime, taskContext) => {
			await runtime.commit(() => ABORTED, taskContext);
		},
	});
}
