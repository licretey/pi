/**
 * Git 检查点扩展。
 *
 * 每轮创建 git stash 检查点，以便 /fork 恢复代码状态。
 * 创建分支时，会询问是否将代码恢复到历史记录对应位置。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const checkpoints = new Map<string, string>();
	let currentEntryId: string | undefined;

	// 保存用户消息时跟踪当前条目 ID。
	pi.on("tool_result", async (_event, ctx) => {
		const leaf = ctx.sessionManager.getLeafEntry();
		if (leaf) currentEntryId = leaf.id;
	});

	pi.on("turn_start", async () => {
		// 在 LLM 修改代码前创建 git stash 条目。
		const { stdout } = await pi.exec("git", ["stash", "create"]);
		const ref = stdout.trim();
		if (ref && currentEntryId) {
			checkpoints.set(currentEntryId, ref);
		}
	});

	pi.on("session_before_fork", async (event, ctx) => {
		const ref = checkpoints.get(event.entryId);
		if (!ref) return;

		if (!ctx.hasUI) {
			// 非交互模式下不自动恢复。
			return;
		}

		const choice = await ctx.ui.select("Restore code state?", [
			"Yes, restore code to that point",
			"No, keep current code",
		]);

		if (choice?.startsWith("Yes")) {
			await pi.exec("git", ["stash", "apply", ref]);
			ctx.ui.notify("Code restored to checkpoint", "info");
		}
	});

	pi.on("agent_settled", async () => {
		// 智能体完整运行结束后清除检查点。
		checkpoints.clear();
	});
}
