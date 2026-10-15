import { copyJson, type Draft, type JsonRepresentation } from "@earendil-works/chord";
import type { Usage } from "@earendil-works/pi-ai";
import { defineDoc } from "../documents.ts";
import type { ConversationId, Tx } from "../types.ts";

/** 单个对话自身开销的账本：其各条目，以及没有使用的压缩摘要尝试。 */
export type UsageState = {
	/** 助手条目与摘要尝试，以 `provider/modelId` 为键。 */
	models: Record<string, JsonRepresentation<Usage>>;
	/** 工具结果，以工具名为键；其用量没有模型身份。 */
	tools: Record<string, JsonRepresentation<Usage>>;
};

export const UsageDoc = defineDoc<UsageState>({
	kind: "pi.usage",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ models: {}, tools: {} }),
	checkpointWhen: () => true,
});

/** 在记录该响应的提交中，把 `usage` 计入对话 `pi.usage` 的某个桶。 */
export async function recordUsage(
	tx: Tx,
	conversationId: ConversationId,
	bucket: keyof UsageState,
	key: string,
	usage: Usage,
): Promise<void> {
	const totals = (await tx.doc(UsageDoc, conversationId))[bucket];
	// 只用自有键：工具可能就叫 `toString`。
	const total = Object.hasOwn(totals, key) ? totals[key] : undefined;
	// 提供方可能让可选计数器保持 `undefined`；草稿要求严格的 JSON。
	if (total === undefined)
		totals[key] = copyJson(usage, { omitUndefinedProperties: true }) as JsonRepresentation<Usage>;
	else addUsage(total, usage);
}

/** 把 `usage` 的每个计数器加到 `total`；只要任一方报告了可选计数器，就累加一次。 */
export function addUsage(total: Draft<Usage> | Usage, usage: Usage): void {
	total.input += usage.input;
	total.output += usage.output;
	total.cacheRead += usage.cacheRead;
	total.cacheWrite += usage.cacheWrite;
	total.totalTokens += usage.totalTokens;
	if (usage.cacheWrite1h !== undefined) total.cacheWrite1h = (total.cacheWrite1h ?? 0) + usage.cacheWrite1h;
	if (usage.reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
	total.cost.input += usage.cost.input;
	total.cost.output += usage.cost.output;
	total.cost.cacheRead += usage.cost.cacheRead;
	total.cost.cacheWrite += usage.cost.cacheWrite;
	total.cost.total += usage.cost.total;
}

/** 把 `state` 的每个桶累加进 `sum`。 */
export function addUsageState(sum: UsageState, state: Readonly<UsageState>): void {
	for (const bucket of ["models", "tools"] as const) {
		for (const [key, usage] of Object.entries(state[bucket])) {
			const total = Object.hasOwn(sum[bucket], key) ? sum[bucket][key] : undefined;
			// 用 define 而不是赋值：赋值给名为 `__proto__` 的工具会设置原型。
			if (total !== undefined) addUsage(total, usage);
			else
				Object.defineProperty(sum[bucket], key, {
					value: structuredClone(usage),
					enumerable: true,
					writable: true,
				});
		}
	}
}
