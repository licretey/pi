/**
 * 感知流式状态的输入门控。
 *
 * 演示如何使用 `event.streamingBehavior`，在重视低延迟的流式引导期间跳过耗时的预处理。
 *
 * 用户提到文件变更时，此扩展会在提示前添加 `git diff --stat` 输出，为模型提供即时上下文。
 * 流式引导期间会跳过 exec 调用，使修正内容能够立即传给模型。
 *
 * 使用此扩展启动 pi：
 *   pi -e ./examples/extensions/input-transform-streaming.ts
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TRIGGER = /\b(changes?|diff|modified)\b/i;

export default function (pi: ExtensionAPI) {
	pi.on("input", async (event) => {
		// 流式引导期间跳过 exec 调用，确保修正内容能快速传达。
		if (event.streamingBehavior === "steer") {
			return { action: "continue" };
		}

		if (!TRIGGER.test(event.text)) {
			return { action: "continue" };
		}

		const { stdout, code } = await pi.exec("git", ["diff", "--stat"]);
		if (code !== 0 || !stdout.trim()) {
			return { action: "continue" };
		}

		return {
			action: "transform",
			text: `${event.text}\n\nCurrent uncommitted changes:\n\`\`\`\n${stdout.trim()}\n\`\`\``,
		};
	});
}
