/**
 * 输入转换示例：演示如何通过 `input` 事件拦截用户输入。
 *
 * 使用此扩展启动 pi：
 *   pi -e ./examples/extensions/input-transform.ts
 *
 * 然后在 pi 中输入以下内容：
 *   ?quick What is TypeScript?  → "简要回答：什么是 TypeScript？"
 *   ping                        → "pong"（立即返回，不调用模型）
 *   time                        → 当前时间（即时获取，不调用 LLM）
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("input", async (event, ctx) => {
		// 根据来源判断：跳过扩展注入的消息。
		if (event.source === "extension") {
			return { action: "continue" };
		}

		// 转换：?quick 前缀用于要求简短回答。
		if (event.text.startsWith("?quick ")) {
			const query = event.text.slice(7).trim();
			if (!query) {
				ctx.ui.notify("Usage: ?quick <question>", "warning");
				return { action: "handled" };
			}
			return { action: "transform", text: `Respond briefly in 1-2 sentences: ${query}` };
		}

		// 处理：无需 LLM 的即时响应（由扩展自行显示反馈）。
		if (event.text.toLowerCase() === "ping") {
			ctx.ui.notify("pong", "info");
			return { action: "handled" };
		}
		if (event.text.toLowerCase() === "time") {
			ctx.ui.notify(new Date().toLocaleString(), "info");
			return { action: "handled" };
		}

		return { action: "continue" };
	});
}
