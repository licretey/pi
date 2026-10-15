/**
 * 危险操作确认扩展。
 *
 * 在执行清空、切换、分支等可能造成数据丢失的会话操作前请求确认。
 * 演示如何通过 before_* 事件取消会话操作。
 */

import type { ExtensionAPI, SessionBeforeSwitchEvent, SessionMessageEntry } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("session_before_switch", async (event: SessionBeforeSwitchEvent, ctx) => {
		if (!ctx.hasUI) return;

		if (event.reason === "new") {
			const confirmed = await ctx.ui.confirm(
				"Clear session?",
				"This will delete all messages in the current session.",
			);

			if (!confirmed) {
				ctx.ui.notify("Clear cancelled", "info");
				return { cancel: true };
			}
			return;
		}

		// reason === "resume"：检查是否存在未保存的更改（上次助手回复之后的消息）。
		const entries = ctx.sessionManager.getEntries();
		const hasUnsavedWork = entries.some(
			(e): e is SessionMessageEntry => e.type === "message" && e.message.role === "user",
		);

		if (hasUnsavedWork) {
			const confirmed = await ctx.ui.confirm(
				"Switch session?",
				"You have messages in the current session. Switch anyway?",
			);

			if (!confirmed) {
				ctx.ui.notify("Switch cancelled", "info");
				return { cancel: true };
			}
		}
	});

	pi.on("session_before_fork", async (event, ctx) => {
		if (!ctx.hasUI) return;

		const choice = await ctx.ui.select(`Fork from entry ${event.entryId.slice(0, 8)}?`, [
			"Yes, create fork",
			"No, stay in current session",
		]);

		if (choice !== "Yes, create fork") {
			ctx.ui.notify("Fork cancelled", "info");
			return { cancel: true };
		}
	});
}
