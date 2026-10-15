import type { ThinkingLevel, ThinkingLevelMap } from "../src/types.ts";

export type ModelsDevReasoningOption =
	| { type: "toggle" }
	| {
			type: "effort";
			values: Array<"none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "default" | null>;
	  }
	| { type: "budget_tokens"; min?: number; max?: number };

const THINKING_LEVELS: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * 将 models.dev 确认支持的 effort 值转换为 Pi 中可选的思考级别。
 * Pi 中没有对应项的值（`default` 和 JSON `null`）会被有意省略。
 */
export function getEffortThinkingLevelMap(options: readonly ModelsDevReasoningOption[]): ThinkingLevelMap | undefined {
	const effortValues = options.flatMap((option) => (option.type === "effort" ? option.values : []));
	if (effortValues.length === 0) return undefined;

	const supported = new Set(effortValues);
	if (!THINKING_LEVELS.some((level) => supported.has(level)) && !supported.has("none")) return undefined;

	const map: ThinkingLevelMap = { off: supported.has("none") ? "none" : null };
	for (const level of THINKING_LEVELS) {
		map[level] = supported.has(level) ? level : null;
	}
	return map;
}
