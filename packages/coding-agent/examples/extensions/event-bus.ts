/**
 * 扩展间事件总线示例。
 *
 * 演示如何通过 pi.events 在扩展之间通信：一个扩展发送事件，其他扩展可以监听。
 *
 * 用法：/emit [event-name] [data] - 在事件总线上发送事件。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	// 保存 ctx，供事件处理器使用。
	let currentCtx: ExtensionContext | undefined;

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
	});

	// 监听其他扩展发送的事件。
	pi.events.on("my:notification", (data) => {
		const { message, from } = data as { message: string; from: string };
		currentCtx?.ui.notify(`Event from ${from}: ${message}`, "info");
	});

	// 发送事件的命令（发送 "my:notification"，由上方的监听器接收）。
	pi.registerCommand("emit", {
		description: "Emit my:notification event (usage: /emit message)",
		handler: async (args, _ctx) => {
			const message = args.trim() || "hello";
			pi.events.emit("my:notification", { message, from: "/emit command" });
			// 上方的监听器会显示通知。
		},
	});

	// 示例：在会话开始时发送事件。
	pi.on("session_start", async () => {
		pi.events.emit("my:notification", {
			message: "Session started",
			from: "event-bus-example",
		});
	});
}
