/**
 * SDK 最简用法。
 *
 * 使用所有默认设置：从 cwd 和 ~/.pi/agent 中发现技能、扩展、工具和上下文文件。
 * 模型根据设置选择；未配置时使用第一个可用模型。
 */

import { createAgentSession } from "@earendil-works/pi-coding-agent";

const { session } = await createAgentSession();

try {
	session.subscribe((event) => {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			process.stdout.write(event.assistantMessageEvent.delta);
		}
	});

	await session.prompt("What files are in the current directory?");
	session.state.messages.forEach((msg) => {
		console.log(msg);
	});
	console.log();
} finally {
	session.dispose();
}
