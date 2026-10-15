/**
 * 隐藏思考标签扩展。
 *
 * 演示如何使用 `ctx.ui.setHiddenThinkingLabel()` 自定义隐藏思考块时显示的标签。
 *
 * 用法：
 *   pi --extension examples/extensions/hidden-thinking-label.ts
 *
 * 测试步骤：
 *   1. 加载此扩展
 *   2. 按 Ctrl+T 隐藏思考块
 *   3. 提出一个会产生推理内容的问题
 *   4. 折叠的思考块会显示自定义标签
 *
 * 命令：
 *   /thinking-label <text>   设置隐藏思考块的自定义标签
 *   /thinking-label          恢复默认标签
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const DEFAULT_LABEL = "Pondering...";

export default function (pi: ExtensionAPI) {
	let label = DEFAULT_LABEL;

	const applyLabel = (ctx: ExtensionContext) => {
		ctx.ui.setHiddenThinkingLabel(label);
	};

	pi.on("session_start", async (_event, ctx) => {
		applyLabel(ctx);
	});

	pi.registerCommand("thinking-label", {
		description: "Set the hidden thinking label. Use without args to reset.",
		handler: async (args, ctx) => {
			const nextLabel = args.trim();

			if (!nextLabel) {
				label = DEFAULT_LABEL;
				ctx.ui.setHiddenThinkingLabel();
				ctx.ui.notify(`Hidden thinking label reset to: ${DEFAULT_LABEL}`);
				return;
			}

			label = nextLabel;
			ctx.ui.setHiddenThinkingLabel(label);
			ctx.ui.notify(`Hidden thinking label set to: ${label}`);
		},
	});
}
