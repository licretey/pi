import {
	type Api,
	type Context,
	calculateCost,
	type Model,
	type ModelsSimpleStreamOptions,
	type SimpleStreamOptions,
	type Usage,
} from "@earendil-works/pi-ai";
import { getProviderEnvValue } from "@earendil-works/pi-ai/utils/provider-env";
import type { ModelRuntime } from "./model-runtime.ts";
import type { SessionEntry, SessionManager, UsageEntry } from "./session-manager.ts";
import type { CacheWarmingMode } from "./settings-manager.ts";

/** 流式预热在启动它的真实请求之后，延续时间绝不超过此值。 */
const MAX_WARMING_AGE_MS = 60 * 60_000;
/** 空闲预热使用更短的时间线，因为随着时间推移，延续估计会变得不那么可靠。 */
const MAX_IDLE_WARMING_AGE_MS = 30 * 60_000;
/** 只在预计至少能节省这么多美元时才发送一次刷新。 */
const CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS = 0.05;
/**
 * agent 空闲期间，缓存条目过期前恰好有真实请求到来的概率。
 * 按我们自己的用量测量；每会话估计并不比这个常量更好。
 */
const IDLE_CONTINUATION_PROBABILITY = 0.15;

/** 在 TTL 的 90% 处刷新，同时至少保留十秒余量。 */
export function getCacheWarmingDelayMs(ttlMs: number): number | undefined {
	if (ttlMs <= 10_000) return undefined;
	return Math.max(1, Math.floor(Math.min(ttlMs * 0.9, ttlMs - 10_000)));
}

/**
 * 一次请求写入的提示缓存条目的存活时间，按该请求使用的 retention 取模型
 * `promptCache` 分层的对应值。模型在该分层没有存活时间或缓存关闭时为 undefined。
 */
export function getPromptCacheTtlMs(model: Model<Api>, options: SimpleStreamOptions | undefined): number | undefined {
	const retention =
		options?.cacheRetention ??
		(getProviderEnvValue("PI_CACHE_RETENTION", options?.env) === "long" ? "long" : "short");
	if (retention === "none") return undefined;
	const seconds = model.promptCache?.[retention];
	return seconds === undefined ? undefined : seconds * 1000;
}

/**
 * 以单 token 输出上限重放请求时，是否可保持其缓存条目不被扰动。Anthropic 的
 * 基于预算的 thinking（无 adaptive thinking 的 Claude 模型）从 `max_tokens` 推导
 * `budget_tokens`；重放会得到不同的预算，而 Anthropic 的消息缓存正是按这个
 * 键区分的，且模型仍可能继续思考成千上万 token。
 */
export function isReplayable(model: Model<Api>, options: SimpleStreamOptions | undefined): boolean {
	if (!options?.reasoning || model.api !== "anthropic-messages") return true;
	return (model as Model<"anthropic-messages">).compat?.forceAdaptiveThinking === true;
}

/** 该分支最近一次真实请求的提示大小，由 provider 上报。 */
function lastPromptTokens(entries: SessionEntry[]): number {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type === "message" && entry.message.role === "assistant") {
			const usage = entry.message.usage;
			return usage.input + usage.cacheRead + usage.cacheWrite;
		}
	}
	return 0;
}

function price(
	model: Model<Api>,
	tokens: Partial<Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite">>,
): number {
	const usage: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...tokens,
	};
	return calculateCost(model, usage).total;
}

export type CacheWarmingAction = "warm" | "stop";

/** 一次 warm-or-stop 决策的输入与结果，在 `/session` 中显示。 */
export interface CacheWarmingDecision {
	/** 发出该请求的 agent run 仍在活动时为 "streaming"。 */
	phase: "streaming" | "idle";
	/** 本次刷新的价格：提示的一次 cache read 加一个输出 token。 */
	warmCost: number;
	/** 缓存条目丢失时，下一次真实请求的额外价格。 */
	missCost: number;
	/** 估计在条目过期前有真实请求到来的概率。 */
	continuationProbability: number;
	/** `continuationProbability * missCost - warmCost`。 */
	expectedSavings: number;
	/** 提示大小或模型价格未知时为 false。 */
	economicsAvailable: boolean;
	/** pi 的决策：`expectedSavings` 至少 $0.05 时为 "warm"。 */
	action: CacheWarmingAction;
}

/**
 * 每次刷新前触发，pi 的决策已被填入。扩展可能还想拿到的其他信息（模型、
 * 空闲状态、上下文大小）都挂在上下文上。
 */
export interface CacheWarmingDecisionEvent
	extends Pick<CacheWarmingDecision, "warmCost" | "missCost" | "continuationProbability" | "action"> {
	type: "cache_warming_decision";
}

export interface CacheWarmingDecisionEventResult {
	/** 覆盖是否发送本次刷新。"stop" 会结束预热，直到下一个真实请求。 */
	action?: CacheWarmingAction;
}

export interface CacheWarmingStatus {
	/** "scheduled"：刷新定时器已就绪；"refreshing"：一个预热请求正在途中。 */
	state: "inactive" | "scheduled" | "refreshing";
	/** 为什么没有调度任何刷新。 */
	reason?: string;
	nextWarmAt?: number;
	/** 待定的决策，或结束预热的那个决策。 */
	decision?: CacheWarmingDecision;
	/** 扩展改动过 `decision.action` 时为 true。 */
	extensionOverride?: boolean;
}

/** 需要保持提示缓存条目温暖的请求，与发送时完全一致。 */
export interface CacheWarmRequest {
	model: Model<Api>;
	context: Context;
	options: ModelsSimpleStreamOptions;
}

interface ActiveRun extends CacheWarmRequest {
	/** 会话的模型或消息不再与请求匹配时为 false。 */
	isCurrent: () => boolean;
	ttlMs: number;
	delayMs: number;
	/** 本次刷新最晚的安全发送时间，保留原有过期余量的一半。 */
	refreshDeadlineAt: number;
	startedAt: number;
	controller: AbortController;
	phase: "streaming" | "idle";
	nextWarmAt: number;
	/** 由扩展强制发起的刷新正在途中时置位。 */
	extensionOverride: boolean;
	timer?: ReturnType<typeof setTimeout>;
}

/**
 * 在条目过期前，以单 token 输出上限重发其请求，以保持一个提示缓存条目存活。
 * `start` 会替换之前的运行；warm 请求绝不延长固定的安全窗口。
 */
export class CacheWarmer {
	private run?: ActiveRun;
	private inactive: CacheWarmingStatus;
	private readonly models: Pick<ModelRuntime, "streamSimple">;
	private readonly sessionManager: Pick<SessionManager, "appendUsage" | "getBranch">;
	private readonly getMode: () => CacheWarmingMode;
	/** 让扩展可以覆盖 `event.action`；失败时回退到 pi 自己的决策。 */
	private readonly decide: (event: CacheWarmingDecisionEvent) => Promise<CacheWarmingAction>;
	/** 每次成功刷新后，带着持久化的 usage 条目调用。 */
	onWarmed?: (entry: UsageEntry) => void;

	constructor(
		models: Pick<ModelRuntime, "streamSimple">,
		sessionManager: Pick<SessionManager, "appendUsage" | "getBranch">,
		getMode: () => CacheWarmingMode,
		decide: (event: CacheWarmingDecisionEvent) => Promise<CacheWarmingAction> = async (event) => event.action,
	) {
		this.models = models;
		this.sessionManager = sessionManager;
		this.getMode = getMode;
		this.decide = decide;
		this.inactive = { state: "inactive", reason: "waiting for first request" };
	}

	get status(): CacheWarmingStatus {
		if (this.getMode() === "off") return { state: "inactive", reason: "cache warming disabled" };
		const run = this.run;
		if (!run) return this.inactive;
		if (!run.isCurrent()) return { state: "inactive", reason: "conversation context changed" };
		const decision = this.evaluate(run);
		const refreshing = run.timer === undefined;
		if (!decision.economicsAvailable && !refreshing) {
			return { state: "inactive", reason: "cache economics unavailable" };
		}
		return {
			state: refreshing ? "refreshing" : "scheduled",
			nextWarmAt: run.nextWarmAt,
			decision,
			extensionOverride: run.extensionOverride,
		};
	}

	/** 只要 `isCurrent` 成立，就让 `request` 写入的提示缓存条目保持温暖。 */
	start(request: CacheWarmRequest, isCurrent: () => boolean): void {
		this.clearRun();
		const mode = this.getMode();
		if (mode === "off") {
			this.stop("cache warming disabled");
			return;
		}
		if (!isReplayable(request.model, request.options)) {
			this.stop("request cannot be replayed safely");
			return;
		}
		const ttlMs = getPromptCacheTtlMs(request.model, request.options);
		if (ttlMs === undefined) {
			this.stop(
				request.options.cacheRetention === "none"
					? "request disabled prompt caching"
					: "cache lifetime unavailable",
			);
			return;
		}
		const delayMs = getCacheWarmingDelayMs(ttlMs);
		if (delayMs === undefined) {
			this.stop("cache lifetime unavailable");
			return;
		}
		this.run = {
			...request,
			isCurrent,
			ttlMs,
			delayMs,
			refreshDeadlineAt: 0,
			startedAt: Date.now(),
			controller: new AbortController(),
			phase: "streaming",
			nextWarmAt: 0,
			extensionOverride: false,
		};
		this.schedule(this.run);
	}

	onAgentSettled(): void {
		const run = this.run;
		if (!run) return;
		if (this.getMode() === "streaming") {
			this.stop("agent run settled");
			return;
		}
		run.phase = "idle";
		const deadline = run.startedAt + MAX_IDLE_WARMING_AGE_MS;
		if (run.nextWarmAt > deadline || Date.now() >= deadline) {
			this.stop("30-minute idle safety limit reached");
		}
	}

	/** 持久化的预热模式变化后，重新协调活动中的 run。 */
	onModeChanged(): void {
		const run = this.run;
		if (!run) return;
		const reason = this.getModeStopReason(run);
		if (reason) this.stop(reason);
	}

	cancel(): void {
		this.stop("inactive");
	}

	private clearRun(): void {
		const run = this.run;
		if (!run) return;
		this.run = undefined;
		if (run.timer) clearTimeout(run.timer);
		run.controller.abort();
	}

	private stop(reason: string, stopped?: Pick<CacheWarmingStatus, "decision" | "extensionOverride">): void {
		this.clearRun();
		this.inactive = { state: "inactive", reason, ...stopped };
	}

	private schedule(run: ActiveRun): void {
		run.extensionOverride = false;
		run.nextWarmAt = Date.now() + run.delayMs;
		// 定时器在系统休眠或事件循环阻塞后可能运行过晚。为这种延迟以及请求
		// 发送本身保留一半的计划内过期前余量；迟到的刷新很可能触发一次
		// 原价缓存写入，而不是一次缓存保温。
		run.refreshDeadlineAt = run.nextWarmAt + Math.floor((run.ttlMs - run.delayMs) / 2);
		const deadline = run.startedAt + (run.phase === "idle" ? MAX_IDLE_WARMING_AGE_MS : MAX_WARMING_AGE_MS);
		if (run.nextWarmAt > deadline || Date.now() >= deadline) {
			this.stop(run.phase === "idle" ? "30-minute idle safety limit reached" : "one-hour safety limit reached");
			return;
		}
		run.timer = setTimeout(() => void this.refresh(run), Math.max(0, run.nextWarmAt - Date.now()));
		run.timer.unref?.();
	}

	private async refresh(run: ActiveRun): Promise<void> {
		run.timer = undefined;
		if (!this.validateRun(run)) return;
		if (this.refreshDeadlineMissed(run)) return;
		const decision = this.evaluate(run);
		const { warmCost, missCost, continuationProbability } = decision;
		let action = decision.action;
		try {
			action = await this.decide({
				type: "cache_warming_decision",
				warmCost,
				missCost,
				continuationProbability,
				action,
			});
		} catch {
			// 扩展失败时回退到 pi 自己的决策。
		}
		if (!this.validateRun(run) || this.refreshDeadlineMissed(run)) return;
		const extensionOverride = action !== decision.action;
		if (action === "stop") {
			const reason = extensionOverride
				? "stopped by extension"
				: decision.economicsAvailable
					? "expected savings below threshold"
					: "cache economics unavailable";
			this.stop(reason, { decision, extensionOverride });
			return;
		}

		run.extensionOverride = extensionOverride;
		try {
			const message = await this.models
				.streamSimple(run.model, run.context, {
					...run.options,
					maxTokens: 1,
					maxRetries: 0,
					signal: run.controller.signal,
				})
				.result();
			if (!this.validateRun(run)) return;
			if (message.stopReason !== "error" && message.stopReason !== "aborted") {
				const entry = this.sessionManager.appendUsage(
					"cache_warm",
					message.provider,
					message.responseModel ?? message.model,
					message.usage,
					extensionOverride ? "extension override" : undefined,
				);
				this.onWarmed?.(entry);
			}
		} catch {
			// 缓存预热尽力而为，绝不能影响活动中的 agent run。
		}
		if (this.run === run) this.schedule(run);
	}

	private refreshDeadlineMissed(run: ActiveRun): boolean {
		if (Date.now() <= run.refreshDeadlineAt) return false;
		this.stop("cache refresh deadline missed");
		return true;
	}

	private validateRun(run: ActiveRun): boolean {
		if (this.run !== run) return false;
		const reason = this.getModeStopReason(run) ?? (!run.isCurrent() ? "conversation context changed" : undefined);
		if (!reason) return true;
		this.stop(reason);
		return false;
	}

	private getModeStopReason(run: ActiveRun): string | undefined {
		const mode = this.getMode();
		if (mode === "off") return "cache warming disabled";
		if (mode === "streaming" && run.phase === "idle") return "agent run settled";
		return undefined;
	}

	private evaluate(run: ActiveRun): CacheWarmingDecision {
		const model = run.model;
		const promptTokens = lastPromptTokens(this.sessionManager.getBranch());
		const cacheHitCost = price(model, { cacheRead: promptTokens });
		const cacheMissCost = price(
			model,
			model.cost.cacheWrite > 0 ? { cacheWrite: promptTokens } : { input: promptTokens },
		);
		const warmCost = price(model, { cacheRead: promptTokens, output: 1 });
		const missCost = Math.max(0, cacheMissCost - cacheHitCost);
		const continuationProbability = run.phase === "idle" ? IDLE_CONTINUATION_PROBABILITY : 1;
		const economicsAvailable = promptTokens > 0 && (cacheHitCost > 0 || cacheMissCost > 0);
		const expectedSavings = continuationProbability * missCost - warmCost;
		return {
			phase: run.phase,
			warmCost,
			missCost,
			continuationProbability,
			expectedSavings,
			economicsAvailable,
			action: expectedSavings >= CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS ? "warm" : "stop",
		};
	}
}

function formatDollars(value: number): string {
	return value < 0 ? `-$${Math.abs(value).toFixed(3)}` : `$${value.toFixed(3)}`;
}

function formatCacheWarmingEconomics(decision: CacheWarmingDecision): string {
	if (!decision.economicsAvailable) return "cache economics unavailable";
	const probability = Math.round(decision.continuationProbability * 100);
	const probabilityText =
		decision.phase === "streaming"
			? `${probability}% continuation probability while agent is running`
			: `${probability}% continuation probability`;
	const comparison = decision.action === "warm" ? ">=" : "<";
	return `${probabilityText}, expected savings ${formatDollars(decision.expectedSavings)} ${comparison} $${CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS.toFixed(3)}`;
}

function formatCacheWarmingDecisionTime(nextWarmAt: number | undefined, now: number): string {
	if (nextWarmAt === undefined || nextWarmAt <= now) return "Decision now";
	let remainingSeconds = Math.ceil((nextWarmAt - now) / 1000);
	const hours = Math.floor(remainingSeconds / 3600);
	remainingSeconds %= 3600;
	const minutes = Math.floor(remainingSeconds / 60);
	const seconds = remainingSeconds % 60;
	const parts: string[] = [];
	if (hours > 0) parts.push(`${hours}h`);
	if (minutes > 0) parts.push(`${minutes}m`);
	if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
	return `Decision in ${parts.join(" ")}`;
}

/** `/session` 使用的一行状态。 */
export function formatCacheWarmingStatus(status: CacheWarmingStatus, now = Date.now()): string {
	const decision = status.decision;
	// pi（或某个扩展）对该决策采取行动后，决策才会被附上；没有决策的
	// "inactive" 从未走到那一步。
	if (!decision || (status.state === "inactive" && !decision.economicsAvailable && !status.extensionOverride)) {
		return `Inactive (${status.reason ?? "unknown reason"})`;
	}
	const details = status.extensionOverride
		? `extension override, ${formatCacheWarmingEconomics(decision)}`
		: `${formatCacheWarmingEconomics(decision)} -> ${decision.action}`;
	if (status.state === "inactive") return `Stopped (${details})`;
	if (status.state === "refreshing") return `Warming cache (${details})`;
	return `${formatCacheWarmingDecisionTime(status.nextWarmAt, now)} (${details})`;
}

/** 持久化的缓存预热用量对应的一行 transcript 文本。 */
export function formatCacheWarmingUsage(entry: UsageEntry): string {
	const note = entry.note ? ` (${entry.note})` : "";
	const cost = entry.usage.cost.total.toFixed(6).replace(/(\.\d{3}\d*?)0+$/, "$1");
	return `Cache warmed${note}: $${cost}`;
}
