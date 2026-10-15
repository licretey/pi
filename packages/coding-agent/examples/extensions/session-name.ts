/**
 * 会话命名示例。
 *
 * 演示如何使用 setSessionName/getSessionName 为会话设置易读名称，
 * 使会话选择器显示该名称，而不是首条消息。
 *
 * 用法：/session-name [name] - 设置或显示会话名称
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("session-name", {
		description: "Set or show session name (usage: /session-name [new name])",
		handler: async (args, ctx) => {
			const name = args.trim();

			if (name) {
				pi.setSessionName(name);
				ctx.ui.notify(`Session named: ${name}`, "info");
			} else {
				const current = pi.getSessionName();
				ctx.ui.notify(current ? `Session: ${current}` : "No session name set", "info");
			}
		},
	});
}
