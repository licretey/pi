import type { ThinkingLevel, ThinkingLevelMap } from "../src/types.ts";
import { getEffortThinkingLevelMap } from "./models-dev-reasoning-options.ts";

export interface OpenRouterReasoningMetadata {
	mandatory?: boolean;
	default_enabled?: boolean;
	supported_efforts?: Array<ThinkingLevel | "none">;
	default_effort?: ThinkingLevel | "none";
}

/** 将 OpenRouter 的推理元数据转换为 Pi 模型能力配置。 */
export function getOpenRouterThinkingLevelMap(
	reasoning: OpenRouterReasoningMetadata | undefined,
): ThinkingLevelMap | undefined {
	if (!reasoning) return undefined;
	if (!reasoning.supported_efforts?.length) return reasoning.mandatory === true ? { off: null } : undefined;

	// OpenRouter 的 supported_efforts 与 models.dev reasoning_options 使用相同的 effort 值，
	// 因此两个来源可以共用 Pi 思考级别的转换逻辑。
	const map = getEffortThinkingLevelMap([{ type: "effort", values: reasoning.supported_efforts }]);
	if (!map) return reasoning.mandatory === true ? { off: null } : undefined;
	return { ...map, off: reasoning.mandatory === true ? null : "none" };
}
