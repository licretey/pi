/**
 * 退出时自动提交扩展
 *
 * 智能体退出时自动提交更改。
 * 使用最近一条 assistant 消息生成提交说明。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("session_shutdown", async (_event, ctx) => {
		// 检查是否存在未提交的更改。
		const { stdout: status, code } = await pi.exec("git", ["status", "--porcelain"]);

		if (code !== 0 || status.trim().length === 0) {
			// 当前目录不是 Git 仓库，或没有更改。
			return;
		}

		// 查找最近一条 assistant 消息，作为提交说明的上下文。
		const entries = ctx.sessionManager.getEntries();
		let lastAssistantText = "";
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry.type === "message" && entry.message.role === "assistant") {
				const content = entry.message.content;
				if (Array.isArray(content)) {
					lastAssistantText = content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("\n");
				}
				break;
			}
		}

		// 生成简短的提交说明。
		const firstLine = lastAssistantText.split("\n")[0] || "Work in progress";
		const commitMessage = `[pi] ${firstLine.slice(0, 50)}${firstLine.length > 50 ? "..." : ""}`;

		// 暂存并提交。
		await pi.exec("git", ["add", "-A"]);
		const { code: commitCode } = await pi.exec("git", ["commit", "-m", commitMessage]);

		if (commitCode === 0 && ctx.hasUI) {
			ctx.ui.notify(`Auto-committed: ${commitMessage}`, "info");
		}
	});
}
