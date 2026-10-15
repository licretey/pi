/**
 * 文件触发器扩展。
 *
 * 监视触发文件，并将文件内容注入对话。
 * 可供外部系统向智能体发送消息。
 *
 * 用法：
 *   echo "运行测试" > /tmp/agent-trigger.txt
 */

import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const triggerFile = "/tmp/agent-trigger.txt";

		fs.watch(triggerFile, () => {
			try {
				const content = fs.readFileSync(triggerFile, "utf-8").trim();
				if (content) {
					pi.sendMessage(
						{
							customType: "file-trigger",
							content: `External trigger: ${content}`,
							display: true,
						},
						{ triggerTurn: true }, // triggerTurn：触发模型回复。
					);
					fs.writeFileSync(triggerFile, ""); // 读取后清空文件。
				}
			} catch {
				// 文件可能尚未创建。
			}
		});

		if (ctx.hasUI) {
			ctx.ui.notify(`Watching ${triggerFile}`, "info");
		}
	});
}
