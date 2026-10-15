/**
 * 自定义消息渲染示例。
 *
 * 展示如何使用 registerMessageRenderer 控制自定义消息在 TUI 中的显示方式，
 * 包括颜色、格式和可展开的详情。
 *
 * 用法：/status [message] - 发送一条使用自定义渲染方式显示的状态消息
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

export default function (pi: ExtensionAPI) {
	// 为 "status-update" 消息注册自定义渲染器
	pi.registerMessageRenderer("status-update", (message, { expanded, outputPad }, theme) => {
		const details = message.details as { level: string; timestamp: number } | undefined;
		const level = details?.level ?? "info";

		// 根据级别选择颜色
		const color = level === "error" ? "error" : level === "warn" ? "warning" : "success";
		const prefix = theme.fg(color, `[${level.toUpperCase()}]`);

		let text = `${prefix} ${message.content}`;

		// 展开时显示时间戳
		if (expanded && details?.timestamp) {
			const time = new Date(details.timestamp).toLocaleTimeString();
			text += `\n${theme.fg("dim", `  at ${time}`)}`;
		}

		// 使用带 customMessageBg 的 Box，保持样式一致
		const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
		box.addChild(new Text(text, 0, 0));
		return box;
	});

	// 发送状态消息的命令
	pi.registerCommand("status", {
		description: "Send a status message (usage: /status [warn|error] message)",
		handler: async (args, _ctx) => {
			const parts = args.trim().split(/\s+/);
			let level = "info";
			let content = args.trim();

			// 检查是否带有级别前缀
			if (parts[0] === "warn" || parts[0] === "error") {
				level = parts[0];
				content = parts.slice(1).join(" ") || "Status update";
			}

			pi.sendMessage({
				customType: "status-update",
				content,
				display: true,
				details: { level, timestamp: Date.now() },
			});
		},
	});
}
