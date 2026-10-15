/**
 * 重新加载运行时扩展。
 *
 * 演示如何在 ExtensionCommandContext 中调用 ctx.reload()，以及如何通过
 * LLM 可调用的工具排队提交后续命令以触发重新加载。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
	// 重新加载命令的入口。
	// 重新加载后，此处理器不会继续执行。
	pi.registerCommand("reload-runtime", {
		description: "Reload extensions, skills, prompts, themes, and context files",
		handler: async (_args, ctx) => {
			await ctx.reload();
			return;
		},
	});

	// 此工具可由 LLM 调用。工具接收的是 ExtensionContext，因此不能直接调用 ctx.reload()。
	// 改为排队提交后续用户命令，由该命令执行上面的重新加载操作。
	pi.registerTool({
		name: "reload_runtime",
		label: "Reload Runtime",
		description: "Reload extensions, skills, prompts, themes, and context files",
		parameters: Type.Object({}),
		async execute() {
			pi.sendUserMessage("/reload-runtime", { deliverAs: "followUp" });
			return {
				content: [{ type: "text", text: "Queued /reload-runtime as a follow-up command." }],
				details: {},
			};
		},
	});
}
