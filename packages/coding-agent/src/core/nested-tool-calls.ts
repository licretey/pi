/**
 * 工具运行期间发起的嵌套工具调用（通过 `ctx.executeTool()`），例如 codemode 脚本中的调用。
 * agent 循环本身并不知道这些调用：会话会让每次调用都经过 agent 的工具处理流程（`runToolCall`）并执行各自的钩子，
 * 发出带有 `parentToolCallId` 的 `tool_execution_*` 事件，并将调用记录及其用量写入模型发起的工具调用结果消息。
 *
 * 只有工具调用 `ctx.executeTool()` 后，这里的逻辑才会运行。
 */

import type {
	AgentTool,
	AgentToolCall,
	AgentToolCallOutcome,
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";
import type { JsonObject, NestedToolCallRecord, NestedToolCalls, TextContent, Usage } from "@earendil-works/pi-ai";
import { combineUsage } from "./usage-totals.ts";

/**
 * 工具结果中嵌套调用记录的限制：超出单次或总大小限制的参数会被省略，超出数量限制的调用会被丢弃；
 * 发生上述任一情况时，记录会标记为不完整。
 */
export const NESTED_CALL_LIMITS = {
	maxCalls: 256,
	maxArgumentBytesPerCall: 8 * 1024,
	maxArgumentBytesTotal: 32 * 1024,
	maxErrorChars: 500,
} as const;

const encoder = new TextEncoder();

/** 一次模型发起的工具调用所产生的嵌套调用信息，最终写入其工具结果消息。 */
export interface NestedCallSummary {
	/** 作为 `nestedCalls` 保存；未发生嵌套调用时为 undefined。 */
	calls: NestedToolCalls | undefined;
	/** 嵌套调用结果的 `usage` 总和，会累加到消息的 `usage` 中。 */
	usage: Usage | undefined;
}

/**
 * 收集模型发起的一次工具调用中的所有嵌套调用，也包括嵌套工具发起的调用。
 * 收集结果会作为 `nestedCalls` 写入工具结果消息。
 */
export class NestedCallRecorder {
	private readonly calls: NestedToolCallRecord[] = [];
	private readonly startedAt = new Map<NestedToolCallRecord, number>();
	private complete = true;
	private argumentBytes = 0;
	/** 所有嵌套调用结果的用量总和，包括未写入记录的调用。 */
	private usage: Usage | undefined;

	/** 在调用开始时记录它；调用被丢弃时返回 undefined。 */
	start(toolCall: AgentToolCall): NestedToolCallRecord | undefined {
		if (this.calls.length >= NESTED_CALL_LIMITS.maxCalls) {
			this.complete = false;
			return undefined;
		}
		const record: NestedToolCallRecord = { id: toolCall.id, name: toolCall.name, status: "unfinished" };
		const json = JSON.stringify(toolCall.arguments ?? {});
		const bytes = encoder.encode(json).length;
		if (
			bytes > NESTED_CALL_LIMITS.maxArgumentBytesPerCall ||
			this.argumentBytes + bytes > NESTED_CALL_LIMITS.maxArgumentBytesTotal
		) {
			record.argumentsBytes = bytes;
			this.complete = false;
		} else {
			record.arguments = JSON.parse(json) as JsonObject;
			this.argumentBytes += bytes;
		}
		this.calls.push(record);
		this.startedAt.set(record, performance.now());
		return record;
	}

	finish(record: NestedToolCallRecord | undefined, isError: boolean, errorText: string): void {
		if (!record) return;
		record.status = isError ? "error" : "ok";
		record.durationMs = Math.round(performance.now() - (this.startedAt.get(record) ?? performance.now()));
		this.startedAt.delete(record);
		if (isError && errorText) record.error = errorText.slice(0, NESTED_CALL_LIMITS.maxErrorChars);
	}

	addUsage(usage: Usage): void {
		this.usage = this.usage ? combineUsage(this.usage, usage) : usage;
	}

	get totalUsage(): Usage | undefined {
		return this.usage;
	}

	/** 当前记录的副本；未发生嵌套调用时返回 undefined。 */
	snapshot(): NestedToolCalls | undefined {
		if (this.calls.length === 0 && this.complete) return undefined;
		const calls = this.calls.map((call) => ({ ...call }));
		return { calls, complete: this.complete && calls.every((call) => call.status !== "unfinished") };
	}
}

export interface NestedToolCallOptions {
	/** 默认使用发起调用的工具所传入的 signal。 */
	signal?: AbortSignal;
	/** 接收嵌套工具的部分结果；此外还会发出 `tool_execution_update` 事件。 */
	onUpdate?: AgentToolUpdateCallback;
}

/** 嵌套调用对应的 `tool_execution_*` 事件。 */
export type NestedToolExecutionEvent =
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown; parentToolCallId: string }
	| {
			type: "tool_execution_update";
			toolCallId: string;
			toolName: string;
			args: unknown;
			partialResult: AgentToolResult<unknown>;
			parentToolCallId: string;
	  }
	| {
			type: "tool_execution_end";
			toolCallId: string;
			toolName: string;
			result: AgentToolResult<unknown>;
			isError: boolean;
			durationMs?: number;
			parentToolCallId: string;
	  };

export interface NestedToolCallHost {
	/** 嵌套调用可解析到的工具列表。 */
	getTools(): readonly AgentTool[];
	/** 是否要求所有嵌套调用独占执行，例如 agent 顺序执行工具调用时。 */
	isSequential(): boolean;
	/** 通过工具处理流程运行调用，并执行上报 `parentToolCallId` 的钩子。 */
	runToolCall(
		toolCall: AgentToolCall,
		parentToolCallId: string,
		signal: AbortSignal | undefined,
		onUpdate: (partialResult: AgentToolResult<unknown>) => Promise<void>,
	): Promise<AgentToolCallOutcome>;
	emit(event: NestedToolExecutionEvent): Promise<void>;
}

/** 同一次模型发起的调用所产生的嵌套调用共用一个记录器。 */
interface CallScope {
	recorder: NestedCallRecorder;
	nextId: number;
	/** 当前调用持有独占队列时设为 true，避免它自己的嵌套调用等待该队列。 */
	holdsQueue: boolean;
}

function textOf(result: AgentToolResult<unknown>): string {
	return (result.content ?? [])
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

export class NestedToolCallRunner {
	private readonly host: NestedToolCallHost;
	/** 以发起工具调用的 ID 为键保存作用域。 */
	private readonly scopes = new Map<string, CallScope>();
	/** 对不得并发运行的嵌套调用进行串行化。 */
	private queueTail: Promise<void> = Promise.resolve();

	constructor(host: NestedToolCallHost) {
		this.host = host;
	}

	/**
	 * 代表 ID 为 `callerId` 的调用运行 `name` 工具。嵌套调用的 ID 为 `<callerId>/<n>`。
	 * 工具调用失败时不会使 Promise 拒绝，而是通过 `isError: true` 返回错误结果。
	 */
	async execute(
		callerId: string,
		name: string,
		args: unknown,
		options: NestedToolCallOptions = {},
	): Promise<AgentToolCallOutcome> {
		let scope = this.scopes.get(callerId);
		if (!scope) {
			scope = { recorder: new NestedCallRecorder(), nextId: 1, holdsQueue: false };
			this.scopes.set(callerId, scope);
		}
		const toolCall: AgentToolCall = {
			type: "toolCall",
			id: `${callerId}/${scope.nextId++}`,
			name,
			arguments: (args ?? {}) as AgentToolCall["arguments"],
		};
		const record = scope.recorder.start(toolCall);
		await this.host.emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: name,
			args: toolCall.arguments,
			parentToolCallId: callerId,
		});

		const exclusive =
			!scope.holdsQueue &&
			(this.host.isSequential() ||
				this.host.getTools().find((tool) => tool.name === name)?.executionMode === "sequential");
		let release: (() => void) | undefined;
		if (exclusive) {
			const previous = this.queueTail;
			this.queueTail = new Promise((resolve) => {
				release = resolve;
			});
			await previous;
		}
		this.scopes.set(toolCall.id, {
			recorder: scope.recorder,
			nextId: 1,
			holdsQueue: scope.holdsQueue || exclusive,
		});
		let outcome: AgentToolCallOutcome;
		try {
			outcome = await this.host.runToolCall(toolCall, callerId, options.signal, async (partialResult) => {
				options.onUpdate?.(partialResult);
				await this.host.emit({
					type: "tool_execution_update",
					toolCallId: toolCall.id,
					toolName: name,
					args: toolCall.arguments,
					partialResult,
					parentToolCallId: callerId,
				});
			});
		} finally {
			this.scopes.delete(toolCall.id);
			release?.();
		}

		scope.recorder.finish(record, outcome.isError, textOf(outcome.result));
		// 嵌套结果不会持久化，因此只通过记录器统计其用量。
		if (outcome.result.usage) scope.recorder.addUsage(outcome.result.usage);
		await this.host.emit({
			type: "tool_execution_end",
			toolCallId: toolCall.id,
			toolName: name,
			result: outcome.result,
			isError: outcome.isError,
			...(outcome.durationMs === undefined ? {} : { durationMs: outcome.durationMs }),
			parentToolCallId: callerId,
		});
		return outcome;
	}

	/** 移除并返回某次模型发起的调用所产生的嵌套调用记录。 */
	takeRecord(toolCallId: string): NestedCallSummary | undefined {
		const scope = this.scopes.get(toolCallId);
		this.scopes.delete(toolCallId);
		if (!scope) return undefined;
		return { calls: scope.recorder.snapshot(), usage: scope.recorder.totalUsage };
	}

	clear(): void {
		this.scopes.clear();
	}
}
