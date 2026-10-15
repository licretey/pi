import type { Context } from "@earendil-works/chord";
import { expect, expectTypeOf, it } from "vitest";
import { idFromNumber, seqFromNumber } from "../src/ids.ts";
import type {
	ContextEdit,
	ConversationId,
	DocumentContent,
	DocumentCreate,
	DocumentId,
	DocumentRecord,
	EntryId,
	StorageWrite,
	SubmissionCreate,
	SubmissionId,
	SubmissionRecord,
	TaskId,
	TaskOutcome,
	TaskRecord,
	TaskState,
} from "../src/index.ts";
import {
	type AnyTask,
	type CompactionResult,
	type Conversation,
	defineExtension,
	defineTask,
	type Extension,
	type Harness,
	type HookApi,
	type HooksOf,
	hook,
	type SettledTask,
	type SubmissionDraft,
	type TaskRuntime,
} from "../src/index.ts";

declare const callContext: Context;

const conversationId = idFromNumber<ConversationId>(1);
const entryId = idFromNumber<EntryId>(2);
const answerId = idFromNumber<EntryId>(3);
const taskId = idFromNumber<TaskId<number>>(4);
const submissionId = idFromNumber<SubmissionId>(5);
const documentId = idFromNumber<DocumentId>(6);
const seq = seqFromNumber(1);

type TaskResult<I> = I extends TaskId<infer R> ? R : never;

it("brands numeric IDs by record kind and carries task result types", () => {
	expect(typeof conversationId).toBe("number");
	expect(JSON.stringify(taskId)).toBe("4");
	expectTypeOf(conversationId).toMatchTypeOf<number>();
	expectTypeOf<TaskResult<typeof taskId>>().toEqualTypeOf<number>();

	const compileTimeFailures = () => {
		const widenedTask: TaskId = idFromNumber<TaskId<{ ok: boolean }>>(7);
		// @ts-expect-error 没有带类型的来源时，已擦除的任务结果类型不能再收窄
		const narrowedTask: TaskId<string> = widenedTask;
		// @ts-expect-error conversation ID 不能赋值给 task ID
		const wrongTask: TaskId = conversationId;
		// @ts-expect-error task ID 不能赋值给 conversation ID
		const wrongConversation: ConversationId = taskId;
		// @ts-expect-error entry ID 不能赋值给 document ID
		const wrongDocument: DocumentId = entryId;
		// @ts-expect-error 实体 ID 不能赋值给提交序号
		const wrongSequence: typeof seq = entryId;
		void [narrowedTask, wrongTask, wrongConversation, wrongDocument, wrongSequence];
	};
	expectTypeOf(compileTimeFailures).toBeFunction();
});

it("encodes discriminator-dependent fields", () => {
	const omit = { target: entryId, action: "omit" } satisfies ContextEdit;
	const replace = { target: entryId, action: "replace", messages: [] } satisfies ContextEdit;
	const pending = { status: "pending", checkpoint: { phase: "ready" } } satisfies TaskState<
		{ phase: string },
		{ value: number }
	>;
	const terminal = {
		status: "terminal",
		outcome: { status: "completed", result: { value: 1 } },
	} satisfies TaskState<{ phase: string }, { value: number }>;
	const completedInput = {
		id: submissionId,
		conversationId,
		type: "input",
		status: "done",
		entry: entryId,
		answer: answerId,
	} satisfies SubmissionRecord;
	const completedWrite = {
		id: submissionId,
		conversationId,
		type: "write",
		status: "done",
		entry: entryId,
	} satisfies SubmissionRecord;
	const queuedWriteCreate = {
		conversationId,
		type: "write",
		status: "queued",
	} satisfies SubmissionCreate;
	const baseContent = { kind: "base", version: 1, value: { count: 1 } } satisfies DocumentContent;
	const deltaContent = { kind: "delta", version: 1, ops: [["s", ["count"], 2]] } satisfies DocumentContent;
	const conversationDocument = {
		id: documentId,
		kind: "test",
		scope: { kind: "conversation", conversationId },
		history: "rewindable",
		fork: "asOf",
	} satisfies DocumentCreate;

	expectTypeOf(omit.action).toEqualTypeOf<"omit">();
	expectTypeOf(replace.action).toEqualTypeOf<"replace">();
	expectTypeOf(pending.status).toEqualTypeOf<"pending">();
	expectTypeOf(terminal.status).toEqualTypeOf<"terminal">();
	expectTypeOf(completedInput.answer).toEqualTypeOf<EntryId>();
	expectTypeOf(completedWrite.type).toEqualTypeOf<"write">();
	expectTypeOf(queuedWriteCreate.status).toEqualTypeOf<"queued">();
	expectTypeOf(baseContent.kind).toEqualTypeOf<"base">();
	expectTypeOf(deltaContent.kind).toEqualTypeOf<"delta">();
	expectTypeOf(conversationDocument.fork).toEqualTypeOf<"asOf">();

	const compileTimeFailures = () => {
		// @ts-expect-error replace 操作必须提供替换消息
		const missingReplacement: ContextEdit = { target: entryId, action: "replace" };
		// @ts-expect-error omit 操作不能携带替换消息
		const omissionWithMessages: ContextEdit = { target: entryId, action: "omit", messages: [] };
		const pendingWithOutcome: TaskState<{ phase: string }, number> = {
			status: "pending",
			checkpoint: { phase: "ready" },
			// @ts-expect-error 运行中的任务状态不能携带终止结果
			outcome: { status: "completed", result: 1 },
		};
		// @ts-expect-error 已终止的任务状态不能保留运行中的检查点
		const terminalWithCheckpoint: TaskState<{ phase: string }, number> = {
			status: "terminal",
			checkpoint: { phase: "ready" },
			outcome: { status: "completed", result: 1 },
		};
		// @ts-expect-error 已终止的任务记录不能保留运行中的备忘数据
		const terminalWithMemos: TaskRecord<null, { phase: string }, number> = {
			id: taskId,
			conversationId,
			kind: "test",
			version: 1,
			input: null,
			state: { status: "terminal", outcome: { status: "completed", result: 1 } },
			background: false,
			abortRequested: false,
			memos: { retained: true },
		};
		// @ts-expect-error session 文档不能声明会话历史行为
		const sessionWithHistory: DocumentRecord = {
			id: documentId,
			kind: "test",
			createdAt: seq,
			scope: { kind: "session" },
			history: "latest",
			fork: "current",
		};
		// @ts-expect-error 创建 conversation 文档时必须指定历史和分支策略
		const conversationWithoutPolicy: DocumentCreate = {
			id: documentId,
			kind: "test",
			scope: { kind: "conversation", conversationId },
		};
		const taskWithPolicy = {
			id: documentId,
			kind: "test",
			scope: { kind: "task", taskId },
			history: "latest",
			fork: "initial",
		} as const;
		// @ts-expect-error 创建 task 文档时不能声明 conversation 策略
		const taskCreateWithPolicy: DocumentCreate = taskWithPolicy;
		const createWithSequence: DocumentCreate = {
			id: documentId,
			kind: "test",
			scope: { kind: "session" },
			// @ts-expect-error createdAt 由存储层提供，而非由创建命令指定
			createdAt: seq,
		};
		// @ts-expect-error 文档基准内容不能携带操作批次
		const baseWithOps: DocumentContent = { kind: "base", version: 1, value: {}, ops: [] };
		// @ts-expect-error 文档增量不能携带已物化的值
		const deltaWithValue: DocumentContent = { kind: "delta", version: 1, ops: [], value: {} };
		const createWithDelta: StorageWrite = {
			type: "document.create",
			record: { id: documentId, kind: "test", scope: { kind: "session" } },
			// @ts-expect-error 创建文档时必须从完整的基准内容开始
			content: { kind: "delta", version: 1, ops: [] },
		};
		// @ts-expect-error 已完成的结果不能携带错误
		const completedWithError: TaskOutcome<number> = {
			status: "completed",
			result: 1,
			error: { message: "impossible" },
		};
		// @ts-expect-error 排队中的提交不能引用会话记录条目
		const queuedWithEntry: SubmissionRecord = {
			id: submissionId,
			conversationId,
			type: "input",
			status: "queued",
			entry: entryId,
		};
		// @ts-expect-error 成功的输入提交必须包含回答条目
		const inputWithoutAnswer: SubmissionRecord = {
			id: submissionId,
			conversationId,
			type: "input",
			status: "done",
			entry: entryId,
		};
		// @ts-expect-error 被动写入提交不能携带回答
		const writeWithAnswer: SubmissionRecord = {
			id: submissionId,
			conversationId,
			type: "write",
			status: "done",
			entry: entryId,
			answer: answerId,
		};
		const submissionCreateWithId: SubmissionCreate = {
			// @ts-expect-error ID 由 Session 分配，不能在提交创建值中指定
			id: submissionId,
			conversationId,
			type: "write",
			status: "queued",
		};
		void [
			missingReplacement,
			omissionWithMessages,
			pendingWithOutcome,
			terminalWithCheckpoint,
			terminalWithMemos,
			sessionWithHistory,
			conversationWithoutPolicy,
			taskCreateWithPolicy,
			createWithSequence,
			baseWithOps,
			deltaWithValue,
			createWithDelta,
			completedWithError,
			queuedWithEntry,
			inputWithoutAnswer,
			writeWithAnswer,
			submissionCreateWithId,
		];
	};

	expectTypeOf(compileTimeFailures).toBeFunction();
});

it("types submissions, task waits, compaction, and tasks erased into extensions", () => {
	const input = { type: "input", content: "hi", whenBusy: "steer" } satisfies SubmissionDraft;
	const write = { type: "write", entry: { kind: "note" } } satisfies SubmissionDraft;
	expectTypeOf(input.type).toEqualTypeOf<"input">();
	expectTypeOf(write.type).toEqualTypeOf<"write">();

	// 输入类型已收窄、包含多个阶段和自定义钩子的任务。
	type Hooks = {
		beforeStep(step: number, api: HookApi, context: Context): { readonly skip: boolean } | undefined;
	};
	type Checkpoint = { phase: "plan"; steps: number } | { phase: "run"; step: number };
	const Stepper = defineTask<{ steps: number }, Checkpoint, { ran: number }, Hooks>({
		name: "test.stepper",
		version: 1,
		initial: (input) => ({ phase: "plan", steps: input.steps }),
		phases: {
			plan: async (task, runtime, context) => {
				expectTypeOf(task.state.checkpoint.steps).toEqualTypeOf<number>();
				expectTypeOf(task.input.steps).toEqualTypeOf<number>();
				await runtime.commit(() => ({ status: "running", checkpoint: { phase: "run", step: 0 } }), context);
			},
			run: async (task, runtime, context) => {
				expectTypeOf(task.state.checkpoint.step).toEqualTypeOf<number>();
				await runtime.hooks.each("beforeStep", (handler) => {
					expectTypeOf(handler).toEqualTypeOf<Hooks["beforeStep"]>();
				});
				await runtime.commit(
					() => ({ status: "terminal", outcome: { status: "completed", result: { ran: 1 } } }),
					context,
				);
			},
		},
		abort: async () => {},
	});
	expectTypeOf<HooksOf<typeof Stepper>>().toEqualTypeOf<Hooks>();
	const registration = hook(Stepper, { beforeStep: (step) => (step > 1 ? { skip: true } : undefined) });
	// 转换为扩展后，其输入、阶段和钩子类型都会被擦除。
	const erased: AnyTask = Stepper;
	const extension: Extension = defineExtension({ name: "stepper", tasks: [Stepper], hooks: [registration] });
	void [erased, extension];

	const typedWaits = async (
		harness: Harness,
		conversation: Conversation,
		runtime: TaskRuntime<null, Checkpoint, null, Hooks>,
	) => {
		const id = await conversation.commit(
			(tx) => tx.createTask(Stepper, { steps: 2 }, { ownership: { kind: "conversation" } }),
			callContext,
		);
		expectTypeOf(id).toEqualTypeOf<TaskId<{ ran: number }>>();
		const settled = await harness.waitForTask(id, callContext);
		expectTypeOf(settled).toEqualTypeOf<SettledTask<{ ran: number }>>();
		if (settled.state.outcome.status === "completed") {
			expectTypeOf(settled.state.outcome.result).toEqualTypeOf<{ ran: number }>();
		}
		expectTypeOf(await runtime.waitForTask(id, callContext)).toEqualTypeOf<SettledTask<{ ran: number }>>();
		const compaction = await conversation.compact(undefined, callContext);
		expectTypeOf(compaction).toEqualTypeOf<TaskId<CompactionResult>>();
		expectTypeOf(await harness.waitForTask(compaction, callContext)).toEqualTypeOf<SettledTask<CompactionResult>>();
	};
	expectTypeOf(typedWaits).toBeFunction();

	const compileTimeFailures = (conversation: Conversation) => {
		// @ts-expect-error input 提交不携带 entry
		const inputWithEntry: SubmissionDraft = { type: "input", content: "hi", entry: { kind: "note" } };
		// @ts-expect-error write 提交不携带内容
		const writeWithContent: SubmissionDraft = { type: "write", entry: { kind: "note" }, content: "hi" };
		// @ts-expect-error write 提交不会触发生成，因此没有 busy 策略
		const writeWhenBusy: SubmissionDraft = { type: "write", entry: { kind: "note" }, whenBusy: "steer" };
		// @ts-expect-error 钩子处理器的类型由任务定义的钩子决定
		const wrongHook = hook(Stepper, { beforeStep: (_step: string) => undefined });
		// @ts-expect-error 钩子名称必须来自任务定义的钩子
		const unknownHook = hook(Stepper, { afterStep: () => undefined });
		const wrongInput = conversation.commit(
			// @ts-expect-error 任务输入类型由任务定义指定
			(tx) => tx.createTask(Stepper, { steps: "two" }, { ownership: { kind: "conversation" } }),
			callContext,
		);
		const missingPhase = defineTask<null, Checkpoint, null>({
			name: "test.missing-phase",
			version: 1,
			initial: () => ({ phase: "plan", steps: 1 }),
			// @ts-expect-error 阶段映射必须覆盖所有阶段
			phases: { plan: async () => {} },
			abort: async () => {},
		});
		void [inputWithEntry, writeWithContent, writeWhenBusy, wrongHook, unknownHook, wrongInput, missingPhase];
	};
	expectTypeOf(compileTimeFailures).toBeFunction();
});
