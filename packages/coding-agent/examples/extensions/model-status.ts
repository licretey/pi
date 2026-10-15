/**
 * 模型状态扩展：在状态栏显示模型变更。
 *
 * 演示 `model_select` 钩子：通过 /model 命令、Ctrl+P 切换模型或恢复会话而更换模型时，
 * 此钩子会触发。
 *
 * 用法：pi -e ./model-status.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("model_select", async (event, ctx) => {
		const { model, previousModel, source } = event;

		// 格式化模型标识符。
		const next = `${model.provider}/${model.id}`;
		const prev = previousModel ? `${previousModel.provider}/${previousModel.id}` : "none";

		// 模型发生变化时显示通知。
		if (source !== "restore") {
			ctx.ui.notify(`Model: ${next}`, "info");
		}

		// 使用当前模型更新状态栏。
		ctx.ui.setStatus("model", `🤖 ${model.id}`);

		// 记录更改详情（可在调试输出中查看）。
		console.log(`[model_select] ${prev} → ${next} (${source})`);
	});
}
