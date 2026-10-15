/**
 * 作为扩展提供的 `tool_search` 工具。CLI 会将其作为内置扩展加载；SDK 使用方可将
 * 将 `createToolSearchExtension()` 加入其扩展工厂。
 *
 * `tool_search` 注册后默认处于未激活状态。可通过 `--tools`、`defaultTools` 设置，或
 * `setActiveTools()` 启用。
 */

import type { ExtensionFactory } from "../../core/extensions/types.ts";
import { createToolSearchToolDefinition } from "./tool.ts";

export function createToolSearchExtension(): ExtensionFactory {
	return (pi) => {
		pi.registerTool({ ...createToolSearchToolDefinition({ tools: pi }), defaultActive: false });
	};
}

export default createToolSearchExtension();
