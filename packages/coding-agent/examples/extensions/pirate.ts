/**
 * 海盗风格扩展。
 *
 * 演示如何在 before_agent_start 阶段修改系统提示词，
 * 根据扩展状态动态改变智能体行为。
 *
 * 用法：
 * 1. 将此文件复制到 ~/.pi/agent/extensions/ 或项目的 .pi/extensions/ 目录
 * 2. 使用 /pirate 切换海盗模式
 * 3. 启用后，智能体会以海盗的口吻回复
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function pirateExtension(pi: ExtensionAPI) {
	let pirateMode = false;

	// 注册 /pirate 命令以切换海盗模式。
	pi.registerCommand("pirate", {
		description: "Toggle pirate mode (agent speaks like a pirate)",
		handler: async (_args, ctx) => {
			pirateMode = !pirateMode;
			ctx.ui.notify(pirateMode ? "Arrr! Pirate mode enabled!" : "Pirate mode disabled", "info");
		},
	});

	// 启用海盗模式时，将内容追加到系统提示词。
	pi.on("before_agent_start", async (event) => {
		if (pirateMode) {
			return {
				systemPrompt:
					event.systemPrompt +
					`

IMPORTANT: You are now in PIRATE MODE. You must:
- Speak like a stereotypical pirate in all responses
- Use phrases like "Arrr!", "Ahoy!", "Shiver me timbers!", "Avast!", "Ye scurvy dog!"
- Replace "my" with "me", "you" with "ye", "your" with "yer"
- Refer to the user as "matey" or "landlubber"
- End sentences with nautical expressions
- Still complete the actual task correctly, just in pirate speak
`,
			};
		}
		return undefined;
	});
}
