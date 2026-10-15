/**
 * 项目可信度扩展。
 *
 * 演示 project_trust 事件。可全局安装，也可通过 -e 参数加载：
 *
 *   mkdir -p ~/.pi/agent/extensions
 *   cp packages/coding-agent/examples/extensions/project-trust.ts ~/.pi/agent/extensions/
 *
 * 或者：
 *
 *   pi -e packages/coding-agent/examples/extensions/project-trust.ts
 *
 * 可在包含 .pi、AGENTS.md/CLAUDE.md 或 .agents/skills 的项目中试用。
 */

import type { ExtensionAPI, ProjectTrustEventResult } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	let loadCount = 0;
	loadCount++;

	// 一个扩展可以注册多个处理器。首个返回 { trusted: "yes" } 或 { trusted: "no" } 的处理器
	// 会生效并跳过内置可信度确认。返回 { trusted: "undecided" }，则交由其他处理器或
	// 内置流程决定。
	pi.on("project_trust", async (event, ctx): Promise<ProjectTrustEventResult> => {
		ctx.ui.notify(`project_trust fired for ${event.cwd} (mode: ${ctx.mode}, load: ${loadCount})`, "info");

		if (!ctx.hasUI) {
			return { trusted: "undecided" };
		}

		const choice = await ctx.ui.select(`Project trust for:\n${event.cwd}`, [
			"Trust and remember",
			"Trust with note and remember",
			"Trust this session",
			"Do not trust this session",
			"Let built-in prompt decide",
		]);

		if (choice === "Trust with note and remember") {
			const note = await ctx.ui.input("Project trust note", "Optional note for this demo");
			ctx.ui.notify(note ? `Recorded demo note: ${note}` : "No demo note entered", "info");
			return { trusted: "yes", remember: true };
		}
		if (choice === "Trust and remember") {
			return { trusted: "yes", remember: true };
		}
		if (choice === "Trust this session") {
			return { trusted: "yes" };
		}
		if (choice === "Do not trust this session") {
			return { trusted: "no" };
		}
		if (choice === "Let built-in prompt decide") {
			return { trusted: "undecided" };
		}
		return { trusted: "undecided" };
	});

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.notify(`project-trust example loaded after trust resolution in ${ctx.cwd}`, "info");
	});
}
