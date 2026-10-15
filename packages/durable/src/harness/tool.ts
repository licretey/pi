import { type Context, copyJson, type Draft, type JsonRepresentation, type JsonValue } from "@earendil-works/chord";
import { awaitWithContext } from "@earendil-works/chord/context";
import { overlap } from "@earendil-works/chord/delta";
import type { ImageContent, TextContent, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { Compile } from "typebox/compile";
import { defineDoc, defineDocFamily } from "../documents.ts";
import { AssistantEntry, ToolResultEntry } from "../entries.ts";
import { errorMessage } from "../errors.ts";
import { defineTask } from "../tasks.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, utf8ByteLength } from "../truncate.ts";
import type {
	ConversationId,
	EntryId,
	JsonObject,
	Task,
	TaskId,
	TaskOptions,
	TaskOutcome,
	TaskRuntime,
	Tx,
	TypedEntry,
} from "../types.ts";
import { assignJson } from "./json.ts";
import {
	clearProgress,
	finishSlot,
	LiveDoc,
	type NestedToolSlot,
	type NestedToolSummary,
	removeNestedSlots,
	type ToolSlot,
	toolSlot,
} from "./live.ts";
import { boundOutput, OutputBuffer, type OutputLimits, PROGRESS_BYTES_PER_SECOND, Progress } from "./output.ts";
import type {
	NestedToolExecutionResult,
	ToolControl,
	ToolDiagnostic,
	ToolExecutionApi,
	ToolExecutionResult,
	ToolHookCall,
	ToolHooks,
	ToolRegistration,
} from "./types.ts";
import { recordUsage } from "./usage.ts";

/**
 * 模型发起的调用——从其 assistant entry 中读取；或某个运行中的工具通过 `executeTool()` 发起的嵌套调用——
 * 因为没有任何 entry 持有它，所以由输入本身携带该调用。
 */
export type ToolTaskInput =
	| { kind: "model"; assistant: EntryId; callId: string }
	| {
			kind: "nested";
			parent: TaskId;
			parentCallId: string;
			key: string;
			call: ToolCall;
			/** `false`：不向 slot 提交运行中的输出、details 或诊断；结果本身仍会带上它们。 */
			progress?: false;
	  };

export type ToolTaskCheckpoint =
	| { phase: "call" }
	/** 持久化的意图：执行前记录的最终参数与 replay 策略。 */
	| { phase: "execute"; arguments: JsonObject; replay: "safe" | "unsafe" };

/**
 * 模型发起的调用，其结果就是它的 transcript entry；嵌套调用的结果存在调用方的 `NestedResultDoc` 里，
 * 这样回执保持很小，结果也随调用方一起退役。Harness 升级时已处于 `completing` 状态的 version 1 任务
 * 会以 version 1 的结果——不带 `kind` 的 `{ entryId, control? }`——收尾；把没有 `kind` 的结果当作模型发起调用的结果。
 */
export type ToolTaskResult = { kind: "model"; entryId: EntryId; control?: ToolControl } | { kind: "nested" };

/** 按键索引一个调用的各嵌套调用，使该调用重跑时能找回它已发起的嵌套调用。 */
const NestedCallsDoc = defineDoc<{ calls: Record<string, TaskId<ToolTaskResult>> }>({
	kind: "pi.tool.nested",
	version: 1,
	scope: "task",
	initial: () => ({ calls: {} }),
});

/**
 * 单个嵌套调用的结果，与 `executeTool()` 返回的完全一致；以嵌套任务 ID 为键，隶属于其调用方的 family。
 * 在嵌套调用的 terminal commit 中写入；每个结果一个文档，任何写入都不会重写其他结果。随调用方一同退役。
 */
export const NestedResultDoc = defineDocFamily<{ result: JsonRepresentation<NestedToolExecutionResult> }, JsonObject>({
	kind: "pi.tool.nested-result",
	version: 1,
	scope: "task",
	family: true,
	initial: (seed) => seed as { result: JsonRepresentation<NestedToolExecutionResult> },
});

type Runtime = TaskRuntime<ToolTaskInput, ToolTaskCheckpoint, ToolTaskResult, ToolHooks>;
type Content = (TextContent | ImageContent)[];

/**
 * 内置的工具任务：在该 phase agent 的工具中解析被调用的工具，校验，运行 `beforeTool`，记录意图，
 * 执行，运行 `afterTool`，最终落定结果——全部在一个 `call` handler 内完成，解析与落定之间不隔着任何东西。
 * 只有恢复流程才会进入 `execute`，并应用 replay 规则。模型发起的调用通过追加结果 entry 落定；
 * 嵌套调用通过把结果写入调用方的 `NestedResultDoc` 落定。
 */
export const ToolTask = defineTask<ToolTaskInput, ToolTaskCheckpoint, ToolTaskResult, ToolHooks>({
	name: "pi.tool",
	version: 2,
	initial: () => ({ phase: "call" }),
	// Version 1 只有模型发起的调用。
	migrate: (input, checkpoint) => ({
		input: { kind: "model", ...(input as { assistant: EntryId; callId: string }) },
		checkpoint: checkpoint as ToolTaskCheckpoint,
	}),
	phases: {
		call: async (task, runtime, context) => {
			const call = await readCall(runtime, task.input, context);
			const tool = await resolveTool(runtime, task.input, call.name, context);
			if (tool === undefined) {
				const error = harnessError("tool_unavailable", `Tool ${call.name} is not available`);
				return settle(runtime, task.input, call, COMPLETED, () => error, context);
			}
			const prepared = prepare(tool, call.arguments as JsonObject);
			const checked = "error" in prepared ? prepared : validate(tool, call, prepared.args);
			if ("error" in checked)
				return settle(runtime, task.input, call, COMPLETED, () => invalid(checked.error), context);
			let args = checked.args;
			let block: string | undefined;
			await runtime.hooks.each("beforeTool", async (hook) => {
				if (block !== undefined) return;
				try {
					const decision = await hook({ ...call, arguments: args }, runtime, context);
					if (decision?.block !== undefined) block = decision.block;
					else if (decision?.arguments !== undefined) args = decision.arguments;
				} catch (error) {
					if (runtime.signal.aborted) throw error;
					block = errorMessage(error);
				}
			});
			if (block !== undefined) {
				const blocked = harnessError("blocked", `Tool call blocked: ${block}`);
				return settle(runtime, task.input, call, COMPLETED, () => blocked, context);
			}
			const validated = validate(tool, call, args);
			if ("error" in validated)
				return settle(runtime, task.input, call, COMPLETED, () => invalid(validated.error), context);
			// 严格 JSON：repair 可能把可选属性设成 undefined，而 slot 与 checkpoint 都无法承载 undefined。
			const final = copyJson(validated.args, { omitUndefinedProperties: true }) as JsonObject;
			await runtime.commit(async (tx) => {
				const slot = toolSlot(await tx.doc(LiveDoc, runtime.conversationId), runtime.taskId);
				if (slot !== undefined) slot.status = "running";
				// 嵌套 slot 显示调用实际运行所用的参数——repair、hook 与类型强转都可能改过它们。
				// 相比 slot 准入时拿到的输入：读 draft 会追踪每一个叶子节点。
				const changed = task.input.kind === "nested" && !jsonEqual(task.input.call.arguments as JsonValue, final);
				if (changed && slot !== undefined && "parentTaskId" in slot) slot.arguments = final;
				const intent = { phase: "execute", arguments: final, replay: tool.replay ?? "unsafe" } as const;
				return { status: "running", checkpoint: intent };
			}, context);
			await run(runtime, task.input, call, tool, final, context);
		},
		/** 恢复流程：仅当存储的与当前的策略都为 `safe` 时才重跑。 */
		execute: async (task, runtime, context) => {
			const { arguments: args, replay } = task.state.checkpoint;
			const call = await readCall(runtime, task.input, context);
			const tool = await resolveTool(runtime, task.input, call.name, context);
			if (replay === "safe" && tool?.replay === "safe") {
				// 重跑从头开始上报；清掉被中断的那次尝试已发布的进度。
				await runtime.commit(async (tx) => {
					const slot = toolSlot(await tx.doc(LiveDoc, runtime.conversationId), runtime.taskId);
					if (slot !== undefined) clearProgress(slot);
					return undefined;
				}, context);
				return run(runtime, task.input, call, tool, args, context);
			}
			const message = `Tool ${call.name} was interrupted and may have partially run`;
			// `failed` 会记录取消意图，于是该调用所拥有的、无人监管的 conversation 会被中止。
			const ending = { status: "failed", message } as const;
			await settle(runtime, task.input, call, ending, (slot) => fromSlot(slot, "interrupted", message), context);
		},
	},
	abort: async (task, runtime, context) => {
		const call = await readCall(runtime, task.input, context);
		// 重启后被遗弃（`TaskOptions.abandonOnRestart`）：说明该调用是否可能已经运行过。
		const [code, message] =
			task.abortReason !== "restart"
				? ["aborted", `Tool ${call.name} was aborted`]
				: task.state.checkpoint.phase === "execute"
					? ["interrupted", `Tool ${call.name} was interrupted by a restart and may have partially run`]
					: ["abandoned", `Tool ${call.name} was not started: its caller ended with a restart`];
		const ending = { status: "aborted" } as const;
		await settle(runtime, task.input, call, ending, (slot) => fromSlot(slot, code, message), context);
	},
});

/** 被调用的工具：模型发起的调用在模型可选的工具中查找，嵌套调用在这些工具里可调用的范围内查找。 */
async function resolveTool(
	runtime: Runtime,
	input: ToolTaskInput,
	name: string,
	context: Context,
): Promise<ToolRegistration | undefined> {
	const agent = await runtime.agent(context);
	return (input.kind === "model" ? agent.tools : agent.callable).find((tool) => tool.name === name);
}

/** 该调用：嵌套调用直接取自输入（hook 会连同其父级一并看到），模型发起的调用取自 assistant entry。 */
async function readCall(runtime: Runtime, input: ToolTaskInput, context: Context): Promise<ToolHookCall> {
	if (input.kind === "nested") return { ...input.call, parent: { taskId: input.parent, callId: input.parentCallId } };
	const entry = await runtime.entry(AssistantEntry, input.assistant, context);
	const message = entry?.model?.[0];
	const call =
		message?.role === "assistant"
			? message.content.find(
					(content): content is ToolCall => content.type === "toolCall" && content.id === input.callId,
				)
			: undefined;
	if (call === undefined) throw new Error(`Entry ${input.assistant} has no tool call ${input.callId}`);
	return call;
}

/** 参数本身，或参数无效的原因。 */
type Checked = { readonly args: JsonObject } | { readonly error: string };

/** 经该工具 repair（修复）后的调用参数；repair 抛错则视为无效。 */
function prepare(tool: ToolRegistration, args: JsonObject): Checked {
	if (tool.prepareArguments === undefined) return { args };
	try {
		return { args: tool.prepareArguments(args) as JsonObject };
	} catch (error) {
		return { error: errorMessage(error) };
	}
}

/** 按实现方的 schema 校验并强转后的参数。 */
function validate(tool: ToolRegistration, call: ToolCall, args: JsonObject): Checked {
	try {
		return { args: validateToolArguments(tool, { ...call, arguments: args }) as JsonObject };
	} catch (error) {
		return { error: errorMessage(error) };
	}
}

function invalid(message: string): ToolExecutionResult {
	return harnessError("invalid_arguments", message);
}

/** 运行中的工具通过其 api 上报的内容：输出、最近的 details 以及诊断。 */
type Reported = {
	readonly output: OutputBuffer;
	readonly limits: OutputLimits;
	readonly diagnostics: ToolDiagnostic[];
	details: JsonValue | undefined;
};

/** 使用已解析的实现执行调用，然后落定其结果。 */
async function run(
	runtime: Runtime,
	input: ToolTaskInput,
	call: ToolHookCall,
	tool: ToolRegistration,
	args: JsonObject,
	context: Context,
): Promise<void> {
	const limits: OutputLimits = {
		maxBytes: tool.outputLimits?.maxBytes ?? DEFAULT_MAX_BYTES,
		maxLines: tool.outputLimits?.maxLines ?? DEFAULT_MAX_LINES,
		retain: tool.outputLimits?.retain ?? "head",
	};
	const reported: Reported = { output: new OutputBuffer(limits), limits, diagnostics: [], details: undefined };
	const streams = input.kind === "model" || input.progress !== false;
	const progress = publishProgress(runtime, reported, streams, context);
	/** 本次调用发起的嵌套调用准入；清理会等它们全部完成，因此能看到每一个嵌套调用。 */
	const admissions: Promise<unknown>[] = [];
	// 能重跑的调用方在重启后会重新附着到它的嵌套调用与子任务；其他调用方从不恢复，
	// 因此它们会被遗弃（`TaskOptions.abandonOnRestart`）。
	const resumes = tool.replay === "safe";
	/** 默认键：本次调用序列的顺序号，使得按相同顺序调用的重跑能够重新附着。 */
	let sequence = 0;
	let ended = false;
	const assertLive = (): void => {
		if (ended) throw new Error(`Tool call ${call.id} has settled`);
	};
	const api: Omit<ToolExecutionApi, "env"> = {
		taskId: runtime.taskId,
		conversationId: runtime.conversationId,
		callId: call.id,
		registry: runtime.registry,
		agent: runtime.agent,
		models: runtime.models,
		output: (chunk, skipped) => {
			assertLive();
			if (reported.output.push(chunk, skipped)) progress.mark();
		},
		outputWindow:
			limits.retain === "tail"
				? {
						maxBytes: limits.maxBytes,
						maxLines: limits.maxLines,
						minIntervalMs: runtime.settings.progress.outputIntervalMs,
						bytesPerSecond: PROGRESS_BYTES_PER_SECOND,
					}
				: undefined,
		retainedOutput: () => {
			assertLive();
			const retained = reported.output.snapshot();
			return { text: retained.text, truncated: retained.droppedBytes > 0 };
		},
		diagnostic: (diagnostic) => {
			assertLive();
			reported.diagnostics.push(copyJson(diagnostic, { omitUndefinedProperties: true }) as ToolDiagnostic);
			progress.mark();
		},
		details: async (value, detailsContext) => {
			assertLive();
			detailsContext.abortSignal?.throwIfAborted();
			reported.details = copyJson(value, { omitUndefinedProperties: true });
			const committed = progress.markAndWait();
			// 取消等待会保留已完成的更新；commit 自身的结局仍会被观察。
			committed.catch(() => {});
			return awaitWithContext(committed, detailsContext);
		},
		commit: async (change, commitContext) => {
			let result: Awaited<ReturnType<typeof change>> | undefined;
			await runtime.commit(async (tx) => {
				result = await change(tx);
				return undefined;
			}, commitContext);
			return result as Awaited<ReturnType<typeof change>>;
		},
		memo: runtime.memo,
		createTask: async <I, S extends { phase: string }, R, H extends object>(
			task: Task<I, S, R, H>,
			input: I,
			options: Omit<TaskOptions, "conversationId">,
			taskContext: Context,
		): Promise<TaskId<R>> => {
			const child = options.ownership.kind === "task" && !resumes ? { abandonOnRestart: true, ...options } : options;
			let id: TaskId<R> | undefined;
			await runtime.commit(async (tx) => {
				id = await tx.createTask(task, input, child);
				return undefined;
			}, taskContext);
			return id!;
		},
		getTask: runtime.getTask,
		waitForTask: runtime.waitForTask,
		conversation: runtime.conversation,
		snapshot: runtime.snapshot,
		snapshotAsOf: runtime.snapshotAsOf,
		watchDoc: runtime.watchDoc,
		executeTool: async (name, toolArgs, callContext, options = {}) => {
			assertLive();
			const key = options.key ?? String(++sequence);
			if (options.key !== undefined) checkKey(options.key);
			const admission = startNestedCall(
				runtime,
				call.id,
				name,
				toolArgs,
				{ key, progress: options.progress, abandonOnRestart: !resumes },
				callContext,
			);
			admissions.push(admission);
			const id = await admission;
			const settled = await runtime.waitForTask(id, callContext);
			const stored = await runtime.snapshot(NestedResultDoc, runtime.taskId, String(id), callContext);
			// 该工具可能修改的副本；被 scheduler 故障化或孤儿化的嵌套调用没有存储结果。
			return stored === undefined
				? fallbackResult(id, name, settled.state.outcome)
				: (copyJson(stored.result as unknown as JsonValue) as unknown as NestedToolExecutionResult);
		},
	};

	let result: ToolExecutionResult;
	let ending = COMPLETED;
	// 本次尝试的执行耗时；恢复后的重跑只测量它自己。
	let durationMs: number | undefined;
	try {
		// 为本次调用构建，因此恢复后的重跑拿到的是当时的 conversation 环境。
		const env = await runtime.env(context);
		const startedAt = performance.now();
		try {
			result = await tool.execute(args, { ...api, env }, context);
		} finally {
			durationMs = Math.round(performance.now() - startedAt);
		}
	} catch (error) {
		if (runtime.signal.aborted) {
			ended = true;
			for (const waiter of await progress.stop()) waiter.reject(error);
			throw error;
		}
		result = { isError: true, diagnostics: [toolDiagnostic("tool_error", errorMessage(error))] };
		// `execute()` 或环境构建抛出的异常会把任务以 `failed` 结束，从而取消该调用所拥有的一切；
		// 它不再监护它们。错误文本已经在结果里。
		ending = { status: "failed", message: `Tool ${call.name} threw` };
	}
	ended = true;
	// `ended` 之后不再发起准入；让进行中的那些提交完毕，落定时即可中止并列出它们的调用。
	await Promise.allSettled(admissions);
	reported.output.end();
	// 仍在等待 progress commit 的 details 会随 terminal commit——最后一次 flush——一起落定。
	const pending = await progress.stop();
	try {
		const settled = await finalResult(runtime, input, call, tool, result, reported, context);
		await settle(runtime, input, call, ending, () => settled, context, durationMs);
	} catch (error) {
		for (const waiter of pending) waiter.reject(error);
		throw error;
	}
	for (const waiter of pending) waiter.resolve();
}

/**
 * 对工具上报内容的节流提交，写入 `pi.live.tools` 或 `pi.live.nestedTools` 中它自己的 slot，每次只写相对上次的变化；
 * `enabled` 为 false 时不提交。
 */
function publishProgress(runtime: Runtime, reported: Reported, enabled: boolean, context: Context): Progress {
	let written = { text: "", details: undefined as JsonValue | undefined, diagnostics: 0 };
	return new Progress(
		async () => {
			if (!enabled) return 0;
			// 同步捕获全部内容：commit 在途时工具仍在上报。
			const snapshot = reported.output.snapshot();
			const current = { text: snapshot.text, details: reported.details, diagnostics: reported.diagnostics.length };
			const added = reported.diagnostics.slice(written.diagnostics, current.diagnostics);
			const detailsChanged = current.details !== written.details;
			// 这次 commit 要写的内容（由 Chord 对字符串做 diff）：一次追加；一次裁剪加上对共享部分之后内容的追加；
			// 或有界重叠搜索找不到共享部分时，整个窗口。
			let bytes = 0;
			if (snapshot.text !== written.text) {
				const shared = snapshot.text.startsWith(written.text)
					? written.text.length
					: overlap(written.text, snapshot.text, 65_536);
				bytes += utf8ByteLength(snapshot.text.slice(shared));
			}
			if (detailsChanged) bytes += utf8ByteLength(JSON.stringify(current.details ?? null));
			if (added.length > 0) bytes += utf8ByteLength(JSON.stringify(added));
			await runtime.commit(async (tx) => {
				const slot = toolSlot(await tx.doc(LiveDoc, runtime.conversationId), runtime.taskId);
				if (slot === undefined) return undefined;
				// 提醒：把 `output` 当作一个字符串字段赋值。Chord 随后把它 diff 成一次追加，或滑动尾部场景下的
				// 一次裁剪加一次追加；替换整个 slot 对象会让每次 commit 都记录整个窗口。
				if ((slot.output ?? "") !== snapshot.text) slot.output = snapshot.text;
				if (snapshot.droppedBytes > 0) slot.droppedBytes = snapshot.droppedBytes;
				if (snapshot.droppedLines > 0) slot.droppedLines = snapshot.droppedLines;
				// 逐叶子 diff details 并追加新诊断，因此每次 commit 只写变化的部分。
				if (detailsChanged && current.details !== undefined) {
					assignJson(slot as unknown as Record<string, JsonValue>, "details", current.details);
				}
				if (added.length > 0) {
					if (slot.diagnostics === undefined) slot.diagnostics = [];
					for (const diagnostic of added) slot.diagnostics.push(diagnostic);
				}
				return undefined;
			}, context);
			written = current;
			return bytes;
		},
		(error) => {
			// abort 标记或关闭之后的 rejection 是预期内的；已提交的状态保持一致。
			if (!runtime.signal.aborted) runtime.report(error);
		},
		runtime.settings.progress.outputIntervalMs,
	);
}

/**
 * 落定的结果：工具的结果，以保留的输出和最近的 details 作为兜底；其诊断排在通过 api 上报的那些之后；
 * 应用 `afterTool`；对显式的文本做上限约束；并按工具的 schema 校验 `structuredOutput`，Harness 的诊断放在最后。
 * `structuredOutput` 违反契约的嵌套调用会得到一个不带它的错误结果；模型发起的调用只会丢失该字段，
 * 且破坏契约一事会报告给宿主。
 */
async function finalResult(
	runtime: Runtime,
	input: ToolTaskInput,
	call: ToolHookCall,
	tool: ToolRegistration,
	result: ToolExecutionResult,
	reported: Reported,
	context: Context,
): Promise<ToolExecutionResult> {
	const harness: ToolDiagnostic[] = [];
	const retained = result.output === undefined ? reported.output.snapshot() : undefined;
	const output: Content =
		retained === undefined ? result.output! : retained.text === "" ? [] : [{ type: "text", text: retained.text }];
	let final: ToolExecutionResult = {
		...result,
		output,
		details: result.details === undefined ? reported.details : result.details,
		diagnostics: [...reported.diagnostics, ...(result.diagnostics ?? [])],
	};
	await runtime.hooks.each("afterTool", async (hook) => {
		final = (await hook(call, final, runtime, context)) ?? final;
	});
	// 保留输出的截断提示只在 afterTool 保住了那份输出时才适用。
	if (retained !== undefined && retained.droppedBytes > 0 && final.output === output) {
		harness.push(truncated(retained, reported.limits.retain));
	}
	const bounded = boundContent(final.output ?? [], reported.limits);
	if (bounded.droppedBytes > 0) harness.push(truncated(bounded, reported.limits.retain));
	const broken = structuredOutputError(tool, final);
	if (broken !== undefined) {
		const { structuredOutput: _dropped, ...rest } = final;
		if (input.kind === "nested") {
			final = { ...rest, isError: true };
			harness.push(toolDiagnostic("invalid_structured_output", broken));
		} else {
			// 模型永远看不到 structured output，因此它的调用依然成立；宿主则会得知该工具破坏了契约。
			final = rest;
			runtime.report(new Error(broken));
		}
	}
	// 没有 schema 时，程序拿到的是输出本身；模型只读 `output`，因此模型发起的调用跳过这一步。
	if (input.kind === "nested" && tool.structuredOutputSchema === undefined) {
		final = { ...final, structuredOutput: outputValue(bounded.content) as JsonValue };
	}
	return { ...final, output: bounded.content, diagnostics: [...(final.diagnostics ?? []), ...harness] };
}

const structuredValidators = new WeakMap<object, ReturnType<typeof Compile>>();

/** 结果的 `structuredOutput` 违反工具契约的原因；未违反时为 `undefined`。 */
function structuredOutputError(tool: ToolRegistration, result: ToolExecutionResult): string | undefined {
	const schema = tool.structuredOutputSchema;
	const value = result.structuredOutput;
	if (schema === undefined) {
		return value === undefined
			? undefined
			: `Tool ${tool.name} returned structuredOutput but declares no structuredOutputSchema`;
	}
	if (value === undefined) {
		return result.isError === true ? undefined : `Tool ${tool.name} returned no structuredOutput`;
	}
	let validator = structuredValidators.get(schema);
	if (validator === undefined) {
		validator = Compile(schema);
		structuredValidators.set(schema, validator);
	}
	if (validator.Check(value)) return undefined;
	const [first] = validator.Errors(value);
	const path = first?.instancePath.replace(/^\//, "").replace(/\//g, ".") || "root";
	return `Tool ${tool.name} returned structuredOutput that does not match its schema: ${path}: ${first?.message ?? "invalid"}`;
}

/**
 * 提交工具的终态并把它的 slot 标记为完成。模型发起的调用会追加结果 entry 并以 entry ID 结束；
 * 嵌套调用把结果写入调用方的 `NestedResultDoc`，记录用量，并以一个小回执结束。
 * 该调用遗留在运行中的嵌套调用会先被中止，以便在调用之下那些 slot 离开 `pi.live` 之前向各自的 slot 上报。
 * `build` 收到 slot，让中断与中止能把持久的部分输出写进结果。
 */
async function settle(
	runtime: Runtime,
	input: ToolTaskInput,
	call: ToolHookCall,
	ending: Ending,
	build: (slot: Readonly<ToolSlot | NestedToolSlot> | undefined) => ToolExecutionResult,
	context: Context,
	durationMs?: number,
): Promise<void> {
	// 中途崩溃会把调用留在 `execute`：safe 重跑会重新附着到各调用，中断则在这里结束。
	const index = await runtime.snapshot(NestedCallsDoc, runtime.taskId, context);
	const nestedIds = Object.values(index?.calls ?? {}).sort((a, b) => a - b);
	// 在等待任何一个之前先全部标记：其中某个可能要运行到兄弟调用被取消为止。
	await Promise.all(nestedIds.map((id) => runtime.abortOwned(id, context)));
	await runtime.commit(async (tx) => {
		const conversationId = runtime.conversationId;
		const live = await tx.doc(LiveDoc, conversationId);
		const slot = toolSlot(live, runtime.taskId);
		const result = build(slot);
		let settled: ToolTaskResult;
		if (input.kind === "nested") {
			const nested = nestedResult(runtime.taskId, result, durationMs);
			if (nested.usage !== undefined) await recordUsage(tx, conversationId, "tools", call.name, nested.usage);
			// 调用方绝不会先于它所拥有的嵌套调用进入终态；entry 缺失属于 bug，而非竞态。
			if ((await tx.doc(NestedCallsDoc, input.parent)).calls[input.key] !== runtime.taskId) {
				throw new Error(`Nested call ${call.id} is not in its caller's index`);
			}
			const stored = { result: nested as unknown as JsonRepresentation<NestedToolExecutionResult> };
			await tx.doc(NestedResultDoc, input.parent, String(runtime.taskId), stored);
			if (slot !== undefined && "parentTaskId" in slot) {
				finishSlot(slot);
				slot.summary = summaryOf(nested, result.output ?? []);
			}
			settled = { kind: "nested" };
		} else {
			const timing = { timestamp: runtime.now(), durationMs };
			const entry = await appendToolResult(tx, conversationId, call, result, timing);
			if (slot !== undefined && !("parentTaskId" in slot)) {
				finishSlot(slot);
				slot.entry = entry.id;
			}
			// 工具构造 control 对象时很随意；去掉设为 undefined 的键，让任务结果是严格 JSON。
			const control =
				result.control === undefined || ending.status !== "completed"
					? {}
					: { control: copyJson(result.control as JsonValue, { omitUndefinedProperties: true }) as ToolControl };
			settled = { kind: "model", entryId: entry.id, ...control };
		}
		// 结果里没有嵌套调用的调用，其下没有 slot；跳过扫描让大量叶子保持线性。
		if (nestedIds.length > 0) removeNestedSlots(live, runtime.taskId);
		if (ending.status === "aborted") return { status: "terminal", outcome: { status: "aborted", result: settled } };
		if (ending.status === "failed") {
			const error = { message: ending.message };
			return { status: "terminal", outcome: { status: "failed", error, result: settled } };
		}
		return { status: "terminal", outcome: { status: "completed", result: settled } };
	}, context);
}

/**
 * 嵌套调用的结果，即存储与返回的形态：严格 JSON，不含只有模型读取的 `output`，
 * 也不含只有模型发起调用才应用的 `control`。
 */
function nestedResult(
	taskId: TaskId,
	result: ToolExecutionResult,
	durationMs: number | undefined,
): NestedToolExecutionResult {
	const nested = {
		taskId,
		structuredOutput: result.structuredOutput,
		isError: result.isError ?? false,
		details: result.details,
		diagnostics: result.diagnostics ?? [],
		usage: result.usage,
		durationMs,
	};
	return copyJson(nested as unknown as JsonValue, {
		omitUndefinedProperties: true,
	}) as unknown as NestedToolExecutionResult;
}

/**
 * 在一次 commit 里创建调用 `parentCallId` 的嵌套调用键 `key`：它的工具任务（由调用任务所拥有）、它的 slot，
 * 以及它的索引项。键已存在且指向同一工具、同样参数的调用时，返回那个调用的任务。
 */
async function startNestedCall(
	runtime: Runtime,
	parentCallId: string,
	name: string,
	args: JsonObject,
	options: { readonly key: string; readonly progress: boolean | undefined; readonly abandonOnRestart: boolean },
	context: Context,
): Promise<TaskId<ToolTaskResult>> {
	const key = options.key;
	const call: ToolCall = {
		type: "toolCall",
		id: `${parentCallId}/${key}`,
		name,
		arguments: copyJson(args, { omitUndefinedProperties: true }) as JsonObject,
	};
	let id: TaskId<ToolTaskResult> | undefined;
	await runtime.commit(async (tx) => {
		const index = await tx.doc(NestedCallsDoc, runtime.taskId);
		const existing = Object.hasOwn(index.calls, key) ? index.calls[key] : undefined;
		if (existing !== undefined) {
			const input = (await tx.task(existing))?.input as ToolTaskInput | undefined;
			const same =
				input?.kind === "nested" &&
				input.parent === runtime.taskId &&
				input.call.name === name &&
				jsonEqual(input.call.arguments as JsonValue, call.arguments as JsonValue);
			if (!same) throw new Error(`Nested call ${call.id} was already made with another tool or other arguments`);
			id = existing as TaskId<ToolTaskResult>;
			return undefined;
		}
		const input: ToolTaskInput = {
			kind: "nested",
			parent: runtime.taskId,
			parentCallId,
			key,
			call,
			...(options.progress === false ? { progress: false } : {}),
		};
		const created = await tx.createTask(ToolTask, input, {
			ownership: { kind: "task", taskId: runtime.taskId },
			abandonOnRestart: options.abandonOnRestart,
		});
		index.calls[key] = created;
		const live = await tx.doc(LiveDoc, runtime.conversationId);
		live.nestedTools ??= [];
		const slot: NestedToolSlot = {
			callId: call.id,
			parentCallId,
			parentTaskId: runtime.taskId,
			name,
			taskId: created,
			arguments: call.arguments as JsonObject,
			status: "pending",
		};
		live.nestedTools.push(slot as Draft<NestedToolSlot>);
		id = created;
		return undefined;
	}, context);
	return id!;
}

/**
 * 工具未声明 schema 时，程序从其输出中得到的内容：一个文本项返回其字符串，一个图像返回它自身，
 * 空内容返回 `""`，其余返回内容列表本身。
 */
function outputValue(output: Content): string | ImageContent | Content {
	if (output.length === 0) return "";
	if (output.length > 1) return output;
	const [only] = output;
	return only!.type === "text" ? only!.text : only!;
}

/** 嵌套调用没有存储结果时调用方得到的内容：一个被 scheduler 故障化或孤儿化的结果。 */
function fallbackResult(taskId: TaskId, name: string, outcome: TaskOutcome<ToolTaskResult>): NestedToolExecutionResult {
	const message =
		outcome.status === "faulted"
			? `Tool ${name} failed: ${outcome.error.message}`
			: outcome.status === "orphaned"
				? `Tool ${name} could not resume: ${outcome.reason}`
				: `Tool ${name} ended without a result`;
	const error = harnessError(outcome.status, message);
	return { taskId, isError: true, diagnostics: error.diagnostics ?? [] };
}

/**
 * 工具任务如何结束；无论哪种方式都会追加结果 entry。`failed`（执行抛错或被中断）会为该调用所拥有的
 * conversation 记录取消意图；带 `isError` 的结果仍算完成。
 */
type Ending = { readonly status: "completed" | "aborted" } | { readonly status: "failed"; readonly message: string };

const COMPLETED: Ending = { status: "completed" };

/** 由 slot 中持久化的部分输出、details 与诊断组装出的错误结果。 */
function fromSlot(
	slot: Readonly<ToolSlot | NestedToolSlot> | undefined,
	code: string,
	message: string,
): ToolExecutionResult {
	const diagnostics = [...(slot?.diagnostics ?? [])];
	const droppedBytes = slot?.droppedBytes ?? 0;
	if (droppedBytes > 0) diagnostics.push(truncated({ droppedBytes, droppedLines: slot?.droppedLines ?? 0 }));
	diagnostics.push(toolDiagnostic(code, message));
	return {
		output: slot?.output === undefined || slot.output === "" ? [] : [{ type: "text", text: slot.output }],
		isError: true,
		...(slot?.details === undefined ? {} : { details: slot.details }),
		diagnostics,
	};
}

/** Harness 自己写入的错误结果：没有内容，只有一条带 `code` 的 `error` 诊断。 */
export function harnessError(code: string, message: string): ToolExecutionResult {
	return { output: [], isError: true, diagnostics: [toolDiagnostic(code, message)] };
}

function toolDiagnostic(code: string, message: string): ToolDiagnostic {
	return { severity: "error", code, message };
}

/** Harness 的截断诊断；从 slot 恢复重建时 `retain` 未知。 */
function truncated(
	dropped: { readonly droppedLines: number; readonly droppedBytes: number },
	retain?: "head" | "tail",
): ToolDiagnostic {
	const kept = retain === undefined ? "" : ` to its ${retain === "head" ? "beginning" : "end"}`;
	return {
		severity: "warn",
		code: "truncated",
		message: `Output truncated${kept}: ${dropped.droppedLines} lines, ${dropped.droppedBytes} bytes dropped`,
	};
}

/** 嵌套调用的 summary 保留的错误文本长度上限。 */
const MAX_SUMMARY_ERROR_CHARS = 500;

/** 嵌套调用在其 slot 中的结束方式：错误文本——取自诊断，否则取自 `output`——并做上限约束。 */
function summaryOf(result: NestedToolExecutionResult, output: Content): NestedToolSummary {
	const error = result.isError ? errorTextOf(result, output).slice(0, MAX_SUMMARY_ERROR_CHARS) : "";
	return {
		isError: result.isError,
		...(result.durationMs === undefined ? {} : { durationMs: result.durationMs }),
		...(result.usage === undefined ? {} : { usage: result.usage }),
		...(error === "" ? {} : { error }),
	};
}

/** 嵌套结果的错误消息；没有时取输出中的文本项，以换行连接。 */
function errorTextOf(result: NestedToolExecutionResult, output: Content): string {
	const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
	if (errors.length > 0) return errors.map((diagnostic) => diagnostic.message).join("\n");
	return output.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n");
}

/**
 * 追加一条 `pi.tool-result` entry。内容以渲染后的诊断结尾，使存储的消息与模型所见完全一致；
 * `data` 保存结构化列表。结果的用量会在同一次 commit 中计入 `pi.usage`。
 */
export async function appendToolResult(
	tx: Tx,
	conversationId: ConversationId,
	call: ToolCall,
	result: ToolExecutionResult,
	meta: { readonly timestamp: number; readonly durationMs?: number },
): Promise<TypedEntry<{ diagnostics: ToolDiagnostic[] }>> {
	const { timestamp, durationMs } = meta;
	const diagnostics = [...(result.diagnostics ?? [])];
	const content: Content = [...(result.output ?? [])];
	if (diagnostics.length > 0) content.push({ type: "text", text: renderDiagnostics(diagnostics) });
	const message = {
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content,
		...(result.details === undefined ? {} : { details: result.details }),
		...(result.usage === undefined ? {} : { usage: result.usage }),
		isError: result.isError ?? false,
		...(durationMs === undefined ? {} : { durationMs }),
		timestamp,
	} as ToolResultMessage;
	if (result.usage !== undefined) await recordUsage(tx, conversationId, "tools", call.name, result.usage);
	return tx.appendEntry(ToolResultEntry, conversationId, { model: [message], data: { diagnostics } });
}

function renderDiagnostics(diagnostics: readonly ToolDiagnostic[]): string {
	return `<harness>\n${diagnostics.map((diagnostic) => `[${diagnostic.severity}] ${diagnostic.message}`).join("\n")}\n</harness>`;
}

/**
 * 约束结果内容的文本。拼接后的文本超出上限时，文本项会被替换为单个有界文本项，位置在第一个（head）
 * 或最后一个（tail）文本项处；其余内容保留。
 */
function boundContent(
	content: Content,
	limits: OutputLimits,
): { content: Content; droppedBytes: number; droppedLines: number } {
	const texts = content.filter((item): item is TextContent => item.type === "text");
	const bounded = boundOutput(texts.map((item) => item.text).join(""), limits);
	if (bounded.droppedBytes === 0) return { content, droppedBytes: 0, droppedLines: 0 };
	const keep = limits.retain === "head" ? texts[0] : texts.at(-1);
	const result: Content = [];
	for (const item of content) {
		if (item.type !== "text") result.push(item);
		else if (item === keep) result.push({ ...item, text: bounded.text });
	}
	return { content: result, droppedBytes: bounded.droppedBytes, droppedLines: bounded.droppedLines };
}

/**
 * 显式的嵌套调用键是 call ID 的路径段，因此不同嵌套调用的 ID 永不冲突，也绝不是默认键所用的普通正整数。
 * `__proto__` 不会作为自有键落入索引。
 */
function checkKey(key: string): void {
	if (key === "" || key.includes("/") || key === "__proto__" || /^[1-9][0-9]*$/.test(key)) {
		throw new Error(
			`Nested call key ${JSON.stringify(key)} must be non-empty, without "/", not "__proto__", and not a positive integer`,
		);
	}
}

/** 结构化的 JSON 相等；对象键顺序不影响结果。 */
function jsonEqual(a: JsonValue, b: JsonValue): boolean {
	if (a === b) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	if (Array.isArray(a) || Array.isArray(b)) {
		return (
			Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => jsonEqual(item, b[i]!))
		);
	}
	const keys = Object.keys(a);
	return (
		keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && jsonEqual(a[key]!, b[key]!))
	);
}
