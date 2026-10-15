/**
 * 工作消息持久化测试。
 *
 * 在会话启动时设置自定义工作消息和指示器，以验证它们在加载器重新创建后
 *（例如智能体轮次之间）仍会保留。
 *
 * 用法：
 *   pi --extension examples/extensions/working-message-test.ts
 *
 * 然后在交互模式下发送几条消息。每次加载器出现时，工作消息都应保持为
 * "Working... (custom)"，并显示棕色圆点指示器，而不会恢复为默认的灰色 "Working..."。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CUSTOM_MESSAGE = "\x1b[38;2;155;86;63mWorking... (custom)\x1b[39m";
const CUSTOM_INDICATOR = { frames: ["\x1b[38;2;155;86;63m●\x1b[39m"] };

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setWorkingMessage(CUSTOM_MESSAGE);
		ctx.ui.setWorkingIndicator(CUSTOM_INDICATOR);
	});
}
