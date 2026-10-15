import type { ModelCost, ModelCostRates, ModelCostTier } from "../src/types.ts";

/** 提示长度区间。`min` 为包含边界，`max` 为不包含边界，单位均为提示 token。 */
export interface AiGatewayPriceTier {
	cost?: string | number;
	min?: number;
	max?: number;
}

/** Vercel AI Gateway 的价格，单位为美元/token。 */
export interface AiGatewayPricing {
	input?: string | number;
	output?: string | number;
	input_cache_read?: string | number;
	input_cache_write?: string | number;
	input_tiers?: AiGatewayPriceTier[];
	output_tiers?: AiGatewayPriceTier[];
	input_cache_read_tiers?: AiGatewayPriceTier[];
	input_cache_write_tiers?: AiGatewayPriceTier[];
}

const RATE_FIELDS = [
	{ rate: "input", tiers: "input_tiers" },
	{ rate: "output", tiers: "output_tiers" },
	{ rate: "cacheRead", tiers: "input_cache_read_tiers" },
	{ rate: "cacheWrite", tiers: "input_cache_write_tiers" },
] as const;

function perMillion(value: string | number | undefined): number {
	const parsed = typeof value === "number" ? value : parseFloat(value ?? "0");
	return Number.isFinite(parsed) ? Number((parsed * 1_000_000).toFixed(6)) : 0;
}

/**
 * 将 AI Gateway 价格转换为美元/百万 token。每种费率分别列出提示长度区间；
 * 每个大于零的区间起点都会成为适用于整个请求的价格层级，并采用该起点对应的费率。
 */
export function getAiGatewayCost(pricing: AiGatewayPricing | undefined): ModelCost {
	const base: ModelCostRates = {
		input: perMillion(pricing?.input),
		output: perMillion(pricing?.output),
		cacheRead: perMillion(pricing?.input_cache_read),
		cacheWrite: perMillion(pricing?.input_cache_write),
	};

	const starts = new Set<number>();
	for (const field of RATE_FIELDS) {
		for (const bracket of pricing?.[field.tiers] ?? []) {
			if (bracket.min !== undefined && bracket.min > 0) starts.add(bracket.min);
		}
	}

	const tiers = [...starts]
		.sort((a, b) => a - b)
		.map((start): ModelCostTier => {
			const tier: ModelCostTier = { inputTokensAbove: start - 1, ...base };
			for (const field of RATE_FIELDS) {
				const bracket = pricing?.[field.tiers]?.find(
					(candidate) => (candidate.min ?? 0) <= start && (candidate.max === undefined || start < candidate.max),
				);
				if (bracket?.cost !== undefined) tier[field.rate] = perMillion(bracket.cost);
			}
			return tier;
		});

	return tiers.length > 0 ? { ...base, tiers } : base;
}
