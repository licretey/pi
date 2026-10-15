import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "./session-manager.ts";

/**
 * 提示缓存的 TTL：空闲间隔超过此时长时，值得将其列为缓存未命中的可能原因。
 * Anthropic 的默认缓存 TTL 为 5 分钟。
 */
export const CACHE_TTL_MS = 5 * 60 * 1000;

/** 每轮未命中 token 数不超过此值时，视为缓存断点粒度造成的噪声。 */
const NOISE_FLOOR_TOKENS = 1024;

/** 单条 assistant 消息中统计到的一次缓存未命中。 */
export interface CacheMiss {
	/** 上一轮提示中包含、但本轮未从缓存读取的提示 token 数。 */
	missedTokens: number;
	/** 与完全命中缓存相比多支付的美元金额；价格未知时为 0。 */
	missedCost: number;
	/** 距离上一次请求（也是最近一次刷新缓存的请求）的毫秒数。 */
	idleMs: number;
	/** 与上一次请求相比是否更换了模型。 */
	modelChanged: boolean;
}

export interface CacheWasteTotals {
	missedTokens: number;
	missedCost: number;
	/** 统计到的未命中次数（超过噪声阈值的轮数）。 */
	missCount: number;
}

/** 最简价格查询接口，由 ModelRuntime 实现。费用单位为美元/百万 token。 */
export interface ModelPriceSource {
	getModel(provider: string, modelId: string): { cost: { cacheRead: number } } | undefined;
}

/** 扫描中最近一次请求；其提示内容理论上都应已进入缓存。 */
interface PreviousRequest {
	promptTokens: number;
	modelKey: string;
	timestamp: number;
	/**
	 * 粘性标记：当前扫描区段中较早的请求曾报告过缓存活动。
	 * 用于区分仅支持缓存读取的提供商（类似 OpenAI，不报告缓存写入）发生的完全未命中，
	 * 与从不报告缓存活动的提供商。
	 */
	reportedCache: boolean;
}

/**
 * 根据上一请求计算单条 assistant 消息的缓存未命中情况。以下情况返回 undefined，不计入统计：
 * 首轮请求、重置后、从未报告过缓存活动（提供商不支持缓存），或未命中量低于噪声阈值。
 */
function detectMiss(
	prev: PreviousRequest | undefined,
	message: AssistantMessage,
	models: ModelPriceSource,
): CacheMiss | undefined {
	const usage = message.usage;
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	// 只有此前报告过缓存活动时，零缓存轮次才计入统计：
	// 对仅支持缓存读取的提供商，这表示完全未命中；对从不报告缓存的提供商则没有意义。
	if (!prev || promptTokens <= 0 || (usage.cacheRead + usage.cacheWrite === 0 && !prev.reportedCache)) {
		return undefined;
	}

	const missedTokens = Math.min(prev.promptTokens, promptTokens) - usage.cacheRead;
	if (missedTokens <= NOISE_FLOOR_TOKENS) return undefined;

	// 额外费用 = 未命中的 token 按实际支付费率（input/cacheWrite，包含写入溢价）计费，
	// 而不是按缓存读取费率计费。未命中的 token 只会落在 input 或 cacheWrite 计费项中，
	// 因此实际支付费率可直接从此消息自身的费用明细中计算。
	const paidTokens = usage.input + usage.cacheWrite;
	const paidPerToken = paidTokens > 0 ? (usage.cost.input + usage.cost.cacheWrite) / paidTokens : 0;
	const readPerToken =
		usage.cacheRead > 0
			? usage.cost.cacheRead / usage.cacheRead
			: (models.getModel(message.provider, message.model)?.cost.cacheRead ?? 0) / 1_000_000;

	return {
		missedTokens,
		missedCost: missedTokens * Math.max(0, paidPerToken - readPerToken),
		idleMs: Math.max(0, message.timestamp - prev.timestamp),
		modelChanged: `${message.provider}/${message.model}` !== prev.modelKey,
	};
}

function asPreviousRequest(message: AssistantMessage, reportedCache: boolean): PreviousRequest | undefined {
	const usage = message.usage;
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	if (promptTokens <= 0) return undefined;
	return {
		promptTokens,
		modelKey: `${message.provider}/${message.model}`,
		timestamp: message.timestamp,
		reportedCache: reportedCache || usage.cacheRead + usage.cacheWrite > 0,
	};
}

function scan(
	entries: SessionEntry[],
	models: ModelPriceSource,
): { prev: PreviousRequest | undefined; totals: CacheWasteTotals; misses: Map<AssistantMessage, CacheMiss> } {
	let prev: PreviousRequest | undefined;
	const totals: CacheWasteTotals = { missedTokens: 0, missedCost: 0, missCount: 0 };
	const misses = new Map<AssistantMessage, CacheMiss>();

	for (const entry of entries) {
		if (entry.type === "compaction" || entry.type === "branch_summary") {
			// 上下文确实发生了变化；下一轮提示属于新内容，而不是重复计费的内容。
			// 更换模型不属于豁免情况：完整提示会重新计费，因此仍应统计。
			prev = undefined;
			continue;
		}
		if (entry.type === "usage" && entry.kind === "cache_warm") {
			const promptTokens = entry.usage.input + entry.usage.cacheRead + entry.usage.cacheWrite;
			if (promptTokens > 0) {
				prev = {
					promptTokens,
					modelKey: `${entry.provider}/${entry.model}`,
					timestamp: Date.parse(entry.timestamp),
					reportedCache: true,
				};
			}
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			const miss = detectMiss(prev, entry.message, models);
			if (miss) {
				totals.missedTokens += miss.missedTokens;
				totals.missedCost += miss.missedCost;
				totals.missCount += 1;
				misses.set(entry.message, miss);
			}
			prev = asPreviousRequest(entry.message, prev?.reportedCache ?? false) ?? prev;
		}
	}
	return { prev, totals, misses };
}

/**
 * 会话中的累计缓存浪费：本应从缓存读取、但被重新计费的提示 token
 *（这些 token 已出现在上一轮的提示中）。
 */
export function computeCacheWaste(entries: SessionEntry[], models: ModelPriceSource): CacheWasteTotals {
	return scan(entries, models).totals;
}

/**
 * 会话中统计到的所有缓存未命中，按承担费用的 assistant 消息（引用）作为键。
 * 从条目重建聊天记录时（恢复会话、压缩后重建）用于重新生成转录提示。
 */
export function collectCacheMisses(
	entries: SessionEntry[],
	models: ModelPriceSource,
): Map<AssistantMessage, CacheMiss> {
	return scan(entries, models).misses;
}

/**
 * 检测刚完成的 assistant 消息是否发生缓存未命中。
 * `entries` 不能包含 `message`（message_end 会在持久化之前触发）。
 */
export function detectCacheMiss(
	entries: SessionEntry[],
	message: AssistantMessage,
	models: ModelPriceSource,
): CacheMiss | undefined {
	return detectMiss(scan(entries, models).prev, message, models);
}
