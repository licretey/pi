import { type Context, copyJson, type Draft, type JsonValue } from "@earendil-works/chord";
import type {
	Api,
	AssistantMessage,
	DeferredHandle,
	Message,
	Model,
	ModelThinkingLevel,
	SimpleStreamOptions,
	ToolCall,
} from "@earendil-works/pi-ai";
import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";
import { isRetryableAssistantError, retryDelayMs } from "@earendil-works/pi-ai/utils/retry";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { AssistantEntry, ResetEntry, SystemEntry, UserEntry } from "../entries.ts";
import type { ExecutionEnv } from "../env/index.ts";
import { defineTask } from "../tasks.ts";
import type {
	ConversationId,
	EntryId,
	NextTaskState,
	SubmissionId,
	TaskId,
	TaskRuntime,
	Tx,
	TypedEntry,
} from "../types.ts";
import { addTools } from "./agent.ts";
import { createCompaction, estimateContext, selectCut } from "./compaction.ts";
import { applyBoundary, prepareBoundary } from "./inbox.ts";
import { assignJson } from "./json.ts";
import { endRun, LiveDoc, type LiveState, type ToolSlot } from "./live.ts";
import { planSystemEntries, renderSections, replaySections } from "./prompt.ts";
import { ensureProviderSessionId } from "./provider.ts";
import { appendToolResult, harnessError, ToolTask, type ToolTaskResult } from "./tool.ts";
import type {
	CompactionPolicy,
	CompactionResult,
	ContextView,
	ConversationStreamOptions,
	GenerationHooks,
	ModelRef,
	PromptInput,
	ToolControl,
	UserInput,
} from "./types.ts";
import { recordUsage } from "./usage.ts";

export type GenerationInput = Record<string, never>;

export type GenerationCheckpoint =
	| {
			phase: "prepare";
			attempt: number;
			/** 该 generation 等待过的阻塞性 compaction；它不会再启动其他 compaction（spec §8.3）。 */
			compacted?: TaskId<CompactionResult>;
			/** 触发 `compacted` 的溢出错误文本；`prepare` 恢复时检查一次。 */
			overflow?: string;
	  }
	| {
			phase: "request";
			attempt: number;
			compacted?: TaskId<CompactionResult>;
			model: ModelRef;
			thinkingLevel: ModelThinkingLevel;
			/** 预备阶段 commit 时 settings 的请求选项；恢复后的重发原样使用它们。 */
			streamOptions: ConversationStreamOptions;
			/** 请求中包含的最新 entry。 */
			cutoff: EntryId;
	  }
	| { phase: "retry"; attempt: number; compacted?: TaskId<CompactionResult>; until: number }
	| {
			phase: "poll";
			attempt: number;
			compacted?: TaskId<CompactionResult>;
			model: ModelRef;
			cutoff: EntryId;
			handle: DeferredHandle;
			pollAt: number;
	  }
	| {
			/** 在等待本轮的工具任务，它们由该 generation 拥有（spec §8.5）。 */
			phase: "tools";
			/** 发起工具调用的回答。 */
			assistant: EntryId;
			/** 至此已创建的工具任务，按调用顺序；顺序轮中每启动一个调用就增加一个。 */
			tools: TaskId<ToolTaskResult>[];
			/** 顺序轮中尚未启动的调用，按调用顺序。 */
			pending: string[];
	  };

export type GenerationResult = { entryId: EntryId };

type Runtime = TaskRuntime<GenerationInput, GenerationCheckpoint, GenerationResult, GenerationHooks>;
type Next = NextTaskState<GenerationCheckpoint, GenerationResult>;

/** 分类时需要从产生该消息的请求中得知的内容。 */
type Request = {
	readonly attempt: number;
	readonly compacted: TaskId<CompactionResult> | undefined;
	readonly model: ModelRef;
	readonly cutoff: EntryId;
	/** 到 `cutoff` 为止已提交的模型上下文，phase 已派生出来时带上。 */
	readonly messages?: readonly Message[];
	/** 消息来自轮询时设置；因此仍处于 deferred 的结果会严格推迟到之后轮询。 */
	readonly pollAt?: number;
};

const DEFAULT_POLL_AFTER_MS = 5000;

/**
 * 内置的 generation 任务：准备按位置排布的 system prompt 和工具装载，请求或轮询模型，重试，并对响应分类。
 * run 的输入存放在 `pi.live.run`。
 */
export const GenerationTask = defineTask<GenerationInput, GenerationCheckpoint, GenerationResult, GenerationHooks>({
	name: "pi.generation",
	version: 1,
	initial: () => ({ phase: "prepare", attempt: 1 }),
	phases: {
		/**
		 * 渲染 system prompt 与工具装载，并追加它们所需的按位置排布的 `pi.system` entry，然后进入 `request`。
		 * 此处解析出的 agent 与 settings 对本次请求固定不变。只有 Harness 会写入忙碌中的 conversation，
		 * 因此这里读到的 transcript 在 commit 时仍是尾部。
		 */
		prepare: async (task, runtime, context) => {
			const { conversationId } = runtime;
			const agent = await runtime.agent(context);
			const settings = runtime.settings;
			const { model, thinkingLevel } = agent;
			const resolved = model === undefined ? undefined : runtime.models.getModel(model.provider, model.modelId);
			if (model === undefined || resolved === undefined) return failNoModel(runtime, model, context);
			const { attempt, compacted, overflow } = task.state.checkpoint;
			if (compacted !== undefined && overflow !== undefined) {
				const [outcome] = await runtime.outcomes([compacted], context);
				if (outcome?.status !== "completed" || outcome.result.entryId === undefined) {
					return failModelError(runtime, overflow, context);
				}
			}
			const view = await runtime.context(conversationId, context);
			const shown = replaySections(view.messages);
			const report = (error: unknown) => runtime.report(error);
			let env: ExecutionEnv | undefined;
			try {
				env = await runtime.env(context);
			} catch (error) {
				if (context.abortSignal?.aborted) throw error;
				report(error);
			}
			const input: PromptInput = { conversationId, agent, env, shown: Object.fromEntries(shown), read: runtime };
			const desired = await renderSections(agent.sections, input, shown, report, context);
			const entries = planSystemEntries(view, desired, agent.tools, runtime.now());
			const threshold =
				compacted === undefined
					? thresholdCompaction(view, entries, resolved.contextWindow, settings.compaction)
					: undefined;
			if (threshold === "blocking") {
				// 先做 compaction 再重新预备；在 compaction 追加之前 transcript 保持不变。
				await runtime.commit(async (tx): Promise<Next> => {
					const child = await createCompaction(tx, conversationId, { reason: "threshold" }, runtime.taskId);
					const checkpoint = { phase: "prepare", attempt, compacted: child } as const;
					return { status: "waiting", checkpoint, on: [child], policy: "allSettled" };
				}, context);
				return;
			}
			await runtime.commit(async (tx) => {
				let cutoff = (await tx.scanEntries({ conversationId }, 1)).items[0]?.id;
				for (const entry of entries) cutoff = (await tx.appendEntry(SystemEntry, conversationId, entry)).id;
				if (cutoff === undefined) throw new Error(`Conversation ${conversationId} has no entries to send`);
				// 在本次 commit 内检查，因此预备期间准入的 compaction 也算数。
				if (threshold === "background" && (await tx.doc(LiveDoc, conversationId)).compactions === undefined) {
					await createCompaction(tx, conversationId, { reason: "threshold" });
				}
				const request = {
					attempt,
					...(compacted === undefined ? {} : { compacted }),
					model,
					thinkingLevel,
					streamOptions: settings.stream,
					cutoff,
				};
				return { status: "running", checkpoint: { phase: "request", ...request } };
			}, context);
		},
		request: async (task, runtime, context) => {
			const { attempt, compacted, model: ref, thinkingLevel, streamOptions, cutoff } = task.state.checkpoint;
			const conversationId = runtime.conversationId;
			await runtime.commit(async (tx) => {
				const live = await tx.doc(LiveDoc, conversationId);
				await convertPartial(tx, live, conversationId);
				live.generation = { attempt };
				return undefined;
			}, context);
			const model = runtime.models.getModel(ref.provider, ref.modelId);
			if (model === undefined) return failNoModel(runtime, ref, context);
			const view = await runtime.context(conversationId, context, { at: cutoff });
			let messages = view.messages;
			await runtime.hooks.each("beforeRequest", async (hook) => {
				const replaced = await hook({ messages }, runtime, context);
				if (replaced !== undefined) messages = replaced.messages;
			});
			const options: SimpleStreamOptions = {
				...streamOptions,
				signal: runtime.signal,
				sessionId: await ensureProviderSessionId(runtime, context),
				...(thinkingLevel === "off" ? {} : { reasoning: thinkingLevel }),
			};
			const message = await streamResponse(runtime, model, messages, options, attempt, context);
			const request = { attempt, compacted, model: ref, cutoff, messages: view.messages };
			await classify(runtime, request, message, context);
		},
		retry: async (task, runtime, context) => {
			const { attempt, compacted, until } = task.state.checkpoint;
			await runtime.sleep(until, context);
			await runtime.commit(async (tx) => {
				(await tx.doc(LiveDoc, runtime.conversationId)).generation = { attempt: attempt + 1 };
				const checkpoint: GenerationCheckpoint = {
					phase: "prepare",
					attempt: attempt + 1,
					...(compacted === undefined ? {} : { compacted }),
				};
				return { status: "running", checkpoint };
			}, context);
		},
		poll: async (task, runtime, context) => {
			const { attempt, compacted, model: ref, cutoff, handle, pollAt } = task.state.checkpoint;
			const model = runtime.models.getModel(ref.provider, ref.modelId);
			if (model === undefined) return failNoModel(runtime, ref, context);
			await runtime.sleep(pollAt, context);
			const message = await runtime.models.fetchDeferred(model, handle, { signal: runtime.signal });
			const request = { attempt, compacted, model: ref, cutoff, pollAt };
			await classify(runtime, request, message, context);
		},
		tools: async (task, runtime, context) => {
			const { assistant, tools, pending } = task.state.checkpoint;
			const [next, ...rest] = pending;
			if (next === undefined) return finishToolRound(runtime, assistant, tools, context);
			// 顺序轮：启动下一个调用并等待它。
			await runtime.commit(async (tx): Promise<Next> => {
				const live = await tx.doc(LiveDoc, runtime.conversationId);
				const taskId = await createToolTask(tx, runtime, assistant, next);
				const slot = live.tools?.find((slot) => slot.callId === next && slot.taskId === undefined);
				if (slot !== undefined) slot.taskId = taskId;
				const checkpoint: GenerationCheckpoint = {
					phase: "tools",
					assistant,
					tools: [...tools, taskId],
					pending: rest,
				};
				return { status: "waiting", checkpoint, on: [taskId], policy: "allSettled" };
			}, context);
		},
	},
	abort: async (task, runtime, context) => {
		const checkpoint = task.state.checkpoint;
		if (checkpoint.phase === "poll") {
			const model = runtime.models.getModel(checkpoint.model.provider, checkpoint.model.modelId);
			if (model !== undefined) {
				try {
					await runtime.models.cancelDeferred(model, checkpoint.handle, { signal: runtime.signal });
				} catch (error) {
					runtime.report(error);
				}
			}
		}
		const conversationId = runtime.conversationId;
		// 在本轮工具任务全部进入终态后运行；从未启动的调用会得到 `aborted` 结果（spec §8.5）。
		const unstarted =
			checkpoint.phase === "tools"
				? await readCalls(runtime, checkpoint.assistant, checkpoint.pending, context)
				: [];
		await runtime.commit(async (tx) => {
			const live = await tx.doc(LiveDoc, conversationId);
			await convertPartial(tx, live, conversationId);
			for (const call of unstarted) {
				const result = harnessError("aborted", `Tool ${call.name} was aborted`);
				await appendToolResult(tx, conversationId, call, result, { timestamp: runtime.now() });
			}
			endRun(tx, live, runtime.taskId, { status: "unanswered", reason: "aborted" });
			return { status: "terminal", outcome: { status: "aborted" } };
		}, context);
	},
});

/** assistant entry 中 `callIds` 指定的调用，按给定顺序返回。 */
async function readCalls(
	runtime: Runtime,
	assistant: EntryId,
	callIds: readonly string[],
	context: Context,
): Promise<ToolCall[]> {
	const message = (await runtime.entry(AssistantEntry, assistant, context))?.model?.[0];
	const calls = message?.role === "assistant" ? message.content.filter((content) => content.type === "toolCall") : [];
	return callIds.flatMap((id) => calls.filter((call) => call.id === id).slice(0, 1));
}

/** 调用 `callId` 的工具任务，由该 generation 拥有。 */
function createToolTask(tx: Tx, runtime: Runtime, assistant: EntryId, callId: string): Promise<TaskId<ToolTaskResult>> {
	return tx.createTask(
		ToolTask,
		{ kind: "model", assistant, callId },
		{ ownership: { kind: "task", taskId: runtime.taskId } },
	);
}

/**
 * 预备阶段在其请求之前启动哪种阈值 compaction（spec §8.3）：高于 `contextWindow - reserveTokens` 时为
 * `blocking`，高于 background 阈值时为 `background`，且仅当选区选择能找到切点时。只有当下没有登记任何
 * compaction 时，调用方才会启动 background 的那种。
 */
function thresholdCompaction(
	view: ContextView,
	planned: readonly { readonly model?: readonly Message[] }[],
	contextWindow: number,
	policy: CompactionPolicy,
): "blocking" | "background" | undefined {
	if (!policy.enabled || contextWindow <= 0) return undefined;
	const tokens = estimateContext(
		view,
		planned.flatMap((entry) => entry.model ?? []),
	);
	const blocking = contextWindow - policy.reserveTokens;
	const background = blocking - policy.backgroundTokens;
	const over =
		tokens > blocking ? "blocking" : policy.backgroundTokens > 0 && tokens > background ? "background" : undefined;
	if (over === undefined || selectCut(view, policy.keepRecentTokens) === undefined) return undefined;
	return over;
}

/** 把 run 的输入以 `model_error` 落定为 `unanswered`，并以 `text` 失败。 */
async function failModelError(runtime: Runtime, text: string, context: Context): Promise<void> {
	await runtime.commit(async (tx) => {
		const live = await tx.doc(LiveDoc, runtime.conversationId);
		endRun(tx, live, runtime.taskId, { status: "unanswered", reason: "model_error", detail: text });
		return {
			status: "terminal",
			outcome: { status: "failed", error: { message: text, detail: { reason: "model_error" } } },
		};
	}, context);
}

/** 把 run 的输入以 `no_model` 落定为 `unanswered` 并失败。 */
async function failNoModel(runtime: Runtime, ref: ModelRef | undefined, context: Context): Promise<void> {
	const message =
		ref === undefined ? "No model is configured" : `Model ${ref.provider}/${ref.modelId} is not available`;
	await runtime.commit(async (tx) => {
		const live = await tx.doc(LiveDoc, runtime.conversationId);
		endRun(tx, live, runtime.taskId, { status: "unanswered", reason: "no_model" });
		return { status: "terminal", outcome: { status: "failed", error: { message, detail: { reason: "no_model" } } } };
	}, context);
}

/**
 * 把被中断、中止、故障化或孤儿化的尝试留下的已提交 partial，追加为一条 aborted 状态的 assistant entry；
 * 调用方负责替换或移除 `generation`。
 */
export async function convertPartial(tx: Tx, live: Draft<LiveState>, conversationId: ConversationId): Promise<void> {
	const partial = live.generation?.message;
	if (partial === undefined) return;
	const message = copyJson(partial) as unknown as AssistantMessage;
	await appendAssistant(tx, conversationId, { ...message, stopReason: "aborted" });
}

/**
 * 发起一次流式请求并返回终态消息。partial 作为尾随写入提交，间隔至多 `progress.partialIntervalMs`
 * （默认 100 ms），且同时只有一个 commit 在途；`finally` 停掉节流并等待该 commit 落地，
 * 因此 outcome 之后不会有陈旧的 partial 落入。
 */
async function streamResponse(
	runtime: Runtime,
	model: Model<Api>,
	messages: readonly Message[],
	options: SimpleStreamOptions,
	attempt: number,
	context: Context,
): Promise<AssistantMessage> {
	const interval = runtime.settings.progress.partialIntervalMs;
	let pending: AssistantMessage | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let inFlight: Promise<void> | undefined;
	let stopped = false;
	const flush = (): void => {
		timer = undefined;
		const partial = pending;
		pending = undefined;
		if (partial === undefined || stopped) return;
		inFlight = (async () => {
			// 同步复制：provider 还在持续修改它的 partial。
			const message = copyJson(partial, { omitUndefinedProperties: true });
			await runtime.commit(async (tx) => {
				const live = await tx.doc(LiveDoc, runtime.conversationId);
				live.generation ??= { attempt };
				assignJson(live.generation as Draft<Record<string, JsonValue>>, "message", message);
				return undefined;
			}, context);
		})()
			.catch((error: unknown) => {
				// 中止标记或 close 之后的 rejection 属预期；已提交的状态保持一致。
				if (!runtime.signal.aborted) runtime.report(error);
			})
			.finally(() => {
				inFlight = undefined;
				if (pending !== undefined && !stopped) timer = setTimeout(flush, interval);
			});
	};
	try {
		const events = runtime.models.streamSimple(model, { messages: [...messages] }, options);
		for await (const event of events) {
			// 没有内容的 partial（如 pi-ai 开场的 `start` 事件）什么都不显示；deferred 响应永远到不了它之后，
			// 所以绝不会留下 partial。
			if (event.type === "done" || event.type === "error" || event.partial.content.length === 0) continue;
			pending = event.partial;
			if (timer === undefined && inFlight === undefined) timer = setTimeout(flush, interval);
		}
		return await events.result();
	} finally {
		stopped = true;
		clearTimeout(timer);
		await inFlight;
	}
}

/** 在一次 commit 中对 provider 的终态消息分类，同时清除 partial。 */
async function classify(
	runtime: Runtime,
	request: Request,
	message: AssistantMessage,
	context: Context,
): Promise<void> {
	// 中止标记或 close：由 abort invocation 或重新打开的 run 处理已提交的状态。
	runtime.signal.throwIfAborted();
	const conversationId = runtime.conversationId;
	const { attempt, compacted, model: ref, cutoff } = request;
	if (message.stopReason === "deferred" && message.deferred !== undefined) {
		const handle = message.deferred;
		const pollAt = Math.max(
			runtime.now() + (handle.pollAfterMs ?? DEFAULT_POLL_AFTER_MS),
			request.pollAt === undefined ? Number.NEGATIVE_INFINITY : request.pollAt + 1,
		);
		await runtime.commit(async (tx) => {
			(await tx.doc(LiveDoc, conversationId)).generation = { attempt, deferred: { pollAt } };
			const checkpoint = {
				phase: "poll",
				attempt,
				...(compacted === undefined ? {} : { compacted }),
				model: ref,
				cutoff,
				handle,
				pollAt,
			} as const;
			return { status: "running", checkpoint };
		}, context);
		return;
	}
	await runtime.hooks.each("afterResponse", (hook) => hook(message, runtime, context));
	const calls = message.content.filter((content): content is ToolCall => content.type === "toolCall");
	if (message.stopReason === "toolUse" && calls.length > 0) {
		return startToolRound(runtime, request, message, calls, context);
	}
	if (message.stopReason === "stop" || message.stopReason === "length" || message.stopReason === "toolUse") {
		return answer(runtime, message, context);
	}
	// 重试与 compaction 策略决定下一次尝试，因此现在读取，而非在预备阶段固定。
	const settings = runtime.settings;
	const overflow = message.stopReason === "error" && isContextOverflow(message);
	if (overflow && compacted === undefined && settings.compaction.enabled) {
		const policy = settings.compaction;
		const view = await runtime.context(conversationId, context, { at: cutoff });
		if (selectCut(view, policy.keepRecentTokens) !== undefined) {
			const text = message.errorMessage ?? "Context overflow";
			await runtime.commit(async (tx): Promise<Next> => {
				const live = await tx.doc(LiveDoc, conversationId);
				await appendAssistant(tx, conversationId, message);
				delete live.generation;
				const child = await createCompaction(tx, conversationId, { reason: "overflow" }, runtime.taskId);
				const checkpoint = { phase: "prepare", attempt, compacted: child, overflow: text } as const;
				return { status: "waiting", checkpoint, on: [child], policy: "allSettled" };
			}, context);
			return;
		}
	}
	const policy = settings.retry;
	// 溢出绝不重试：只有 compaction 能让下一次请求装得下。
	const retry =
		message.stopReason === "error" &&
		!overflow &&
		isRetryableAssistantError(message) &&
		policy.enabled &&
		attempt <= policy.maxRetries;
	const until = retry ? runtime.now() + retryDelayMs(policy, attempt) : 0;
	await runtime.commit(async (tx): Promise<Next> => {
		const live = await tx.doc(LiveDoc, conversationId);
		await appendAssistant(tx, conversationId, message);
		if (retry) {
			live.generation = { attempt, retry: { at: until, error: message.errorMessage ?? "" } };
			const checkpoint = {
				phase: "retry",
				attempt,
				...(compacted === undefined ? {} : { compacted }),
				until,
			} as const;
			return { status: "running", checkpoint };
		}
		const text = message.errorMessage ?? `Model response ended with stop reason ${message.stopReason}`;
		endRun(tx, live, runtime.taskId, { status: "unanswered", reason: "model_error", detail: text });
		return {
			status: "terminal",
			outcome: { status: "failed", error: { message: text, detail: { reason: "model_error" } } },
		};
	}, context);
}

/**
 * 最终回答；final 边界会安置排队的条目（spec §6）。第一个 `onYield` 续接会追加一条 user 消息并把 run 交给
 * 后继 generation，但仅当边界没有选出 user 条目且没有 reset 时。否则 run 的输入以 `done` 落定，
 * 选出的 user 条目启动下一个 run。
 */
async function answer(runtime: Runtime, message: AssistantMessage, context: Context): Promise<void> {
	let continuation: UserInput | undefined;
	await runtime.hooks.each("onYield", async (hook) => {
		if (continuation !== undefined) return;
		continuation = (await hook(message, runtime, context))?.continue;
	});
	const conversationId = runtime.conversationId;
	await runtime.commit(async (tx): Promise<Next> => {
		// 队列模式在 Session 线上、边界确定之时读取。
		const boundary = await prepareBoundary(tx, conversationId, runtime.settings);
		const live = await tx.doc(LiveDoc, conversationId);
		const entry = await appendAssistant(tx, conversationId, message);
		const result: Next = { status: "terminal", outcome: { status: "completed", result: { entryId: entry.id } } };
		const { users, reset } = await applyBoundary(tx, boundary, "final", runtime.now());
		if (continuation !== undefined && users.length === 0 && !reset) {
			const user = { role: "user", content: continuation, timestamp: runtime.now() } as const;
			await tx.appendEntry(UserEntry, conversationId, { model: [user] });
			handOver(live, runtime.taskId, await createGeneration(tx, conversationId));
			delete live.generation;
			return result;
		}
		endRun(tx, live, runtime.taskId, { status: "done", answer: entry.id });
		if (users.length > 0) await startRun(tx, conversationId, live, users);
		return result;
	}, context);
}

/**
 * 在一次 commit 中追加发起工具调用的回答并启动它的工具轮（spec §8.3）。调用请求未提供的工具的调用
 * 在这里得到 `tool_unavailable` 结果；其余每个调用都得到一个由 generation 拥有的工具任务——当轮次为顺序
 * 执行时现在只启动第一个。之后 generation 在其 `tools` phase 中等待它们，保住这个 run。
 */
async function startToolRound(
	runtime: Runtime,
	request: Request,
	message: AssistantMessage,
	calls: readonly ToolCall[],
	context: Context,
): Promise<void> {
	const conversationId = runtime.conversationId;
	const messages =
		request.messages ?? (await runtime.context(conversationId, context, { at: request.cutoff })).messages;
	const offered = new Set(getCurrentTools(messages).map((tool) => tool.name));
	// 在轮次启动时读取；工具按其工具任务解析它的方式被解析。
	const tools = (await runtime.agent(context)).tools;
	const sequential =
		runtime.settings.toolExecution === "sequential" ||
		calls.some(
			(call) =>
				offered.has(call.name) && tools.find((tool) => tool.name === call.name)?.executionMode === "sequential",
		);
	await runtime.commit(async (tx): Promise<Next> => {
		const live = await tx.doc(LiveDoc, conversationId);
		const entry = await appendAssistant(tx, conversationId, message);
		const slots: ToolSlot[] = [];
		const tools: TaskId<ToolTaskResult>[] = [];
		const pending: string[] = [];
		for (const call of calls) {
			if (!offered.has(call.name)) {
				const unavailable = harnessError("tool_unavailable", `Tool ${call.name} is not available`);
				const result = await appendToolResult(tx, conversationId, call, unavailable, { timestamp: runtime.now() });
				slots.push({ callId: call.id, name: call.name, status: "done", entry: result.id });
				continue;
			}
			if (sequential && tools.length > 0) {
				pending.push(call.id);
				slots.push({ callId: call.id, name: call.name, status: "pending" });
				continue;
			}
			const taskId = await createToolTask(tx, runtime, entry.id, call.id);
			tools.push(taskId);
			slots.push({ callId: call.id, name: call.name, taskId, status: "pending" });
		}
		delete live.generation;
		live.tools = slots;
		const checkpoint = { phase: "tools", assistant: entry.id, tools, pending } as const;
		return { status: "waiting", checkpoint, on: tools, policy: "allSettled" };
	}, context);
}

/**
 * 本轮的工具已全部进入终态：应用它们的 control，要么在 final 边界结束 run（`terminate`、`handoff`
 * 或排队的 reset），要么在 `postTools` 边界把 run 交给下一个 generation（spec §8.5）。
 */
async function finishToolRound(
	runtime: Runtime,
	assistant: EntryId,
	tools: readonly TaskId<ToolTaskResult>[],
	context: Context,
): Promise<void> {
	const conversationId = runtime.conversationId;
	const controls = new Map<TaskId, ToolControl | undefined>();
	const outcomes = await runtime.outcomes(tools, context);
	tools.forEach((id, index) => {
		const outcome = outcomes[index]!;
		// Version 1 的结果没有 kind；generation 轮次读到的每个结果都是模型发起调用的。
		controls.set(
			id,
			outcome.status === "completed" && outcome.result.kind !== "nested" ? outcome.result.control : undefined,
		);
	});
	const slots = (await runtime.snapshot(LiveDoc, conversationId, context))?.tools ?? [];
	const results = slots.flatMap((slot) => (slot.entry === undefined ? [] : [slot.entry]));
	await runtime.hooks.each("afterTools", (hook) => hook(assistant, results, runtime, context));
	// 本轮的每一个调用——包括那些没有任务就得到回答的——都必须请求 terminate。
	const terminate =
		slots.length > 0 &&
		slots.every((slot) => slot.taskId !== undefined && controls.get(slot.taskId)?.terminate === true);
	const added = [...controls.values()].flatMap((control) => control?.addTools ?? []);
	// 调用顺序中最后一个 handoff 生效。
	const handoff = [...controls.values()].findLast((control) => control?.handoff !== undefined)?.handoff;
	await runtime.commit(async (tx): Promise<Next> => {
		const boundary = await prepareBoundary(tx, conversationId, runtime.settings);
		if (added.length > 0) await addTools(tx, conversationId, added);
		const live = await tx.doc(LiveDoc, conversationId);
		const now = runtime.now();
		if (terminate || handoff !== undefined) {
			if (handoff !== undefined) {
				const message = { role: "user", content: handoff, timestamp: now } as const;
				const entry = await tx.appendEntry(ResetEntry, conversationId, { head: "self", model: [message] });
				boundary.head = entry.id;
			}
			const { users } = await applyBoundary(tx, boundary, "final", now);
			endRun(tx, live, runtime.taskId, { status: "done", answer: assistant });
			if (users.length > 0) await startRun(tx, conversationId, live, users);
		} else {
			const { users, reset } = await applyBoundary(tx, boundary, "postTools", now);
			if (reset) {
				// 排队的 reset 在回答产生之前切掉了 run 的上下文。
				endRun(tx, live, runtime.taskId, { status: "unanswered", reason: "reset" });
				if (users.length > 0) await startRun(tx, conversationId, live, users);
			} else {
				delete live.tools;
				delete live.nestedTools;
				if (live.run?.taskId === runtime.taskId) live.run.inputs.push(...users);
				handOver(live, runtime.taskId, await createGeneration(tx, conversationId));
			}
		}
		return { status: "terminal", outcome: { status: "completed", result: { entryId: assistant } } };
	}, context);
}

/**
 * 追加一条 provider 结果，并在同一次 commit 中把它的用量计入 `pi.usage`。
 * 提醒：所有内置的 assistant entry 写入方都经过这里，因此用量台账保持完整。
 */
async function appendAssistant(
	tx: Tx,
	conversationId: ConversationId,
	message: AssistantMessage,
): Promise<TypedEntry<never>> {
	await recordUsage(tx, conversationId, "models", `${message.provider}/${message.model}`, message.usage);
	return tx.appendEntry(AssistantEntry, conversationId, { model: [message] });
}

/** 为已就位的输入提交 `inputs` 启动一个 run：新的 generation 接管 `pi.live.run`。 */
export async function startRun(
	tx: Tx,
	conversationId: ConversationId,
	live: Draft<LiveState>,
	inputs: SubmissionId[],
): Promise<void> {
	live.run = { taskId: await createGeneration(tx, conversationId), inputs };
}

/** 由其 conversation 拥有的 generation。 */
function createGeneration(tx: Tx, conversationId: ConversationId): Promise<TaskId<GenerationResult>> {
	return tx.createTask(GenerationTask, {}, { ownership: { kind: "conversation" }, conversationId });
}

/** 把 run 的控制权从 `from` 交给 `to`；run 的输入随之迁移。 */
export function handOver(live: Draft<LiveState>, from: TaskId, to: TaskId): void {
	if (live.run?.taskId === from) live.run.taskId = to;
}
