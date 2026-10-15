/**
 * RPC 扩展界面演示。
 *
 * 专门用于测试所有受 RPC 支持的扩展界面方法。
 * 应与 rpc-extension-ui-example.ts 脚本一起加载，以演示完整的扩展界面协议。
 *
 * 测试的界面方法：
 * - select()：在 tool_call 阶段确认危险的 bash 命令
 * - confirm()：在 session_before_switch 阶段确认
 * - input()：通过 /rpc-input 命令调用
 * - editor()：通过 /rpc-editor 命令调用
 * - notify()：每个对话框结束后发送通知
 * - setStatus()：在 turn_start/turn_end 阶段调用
 * - setWidget()：在 session_start 阶段调用
 * - setTitle()：在 session_start 阶段调用
 * - setEditorText()：通过 /rpc-prefill 命令调用
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	let turnCount = 0;

	// -- 在会话生命周期中调用 setTitle、setWidget 和 setStatus --

	pi.on("session_start", async (event, ctx) => {
		ctx.ui.setTitle(event.reason === "new" ? "pi RPC Demo (new session)" : "pi RPC Demo");
		ctx.ui.setWidget("rpc-demo", ["--- RPC Extension UI Demo ---", "Loaded and ready."]);
		ctx.ui.setStatus("rpc-demo", `Turns: ${turnCount}`);
	});

	// -- 在轮次生命周期中调用 setStatus --

	pi.on("turn_start", async (_event, ctx) => {
		turnCount++;
		ctx.ui.setStatus("rpc-demo", `Turn ${turnCount} running...`);
	});

	pi.on("turn_end", async (_event, ctx) => {
		ctx.ui.setStatus("rpc-demo", `Turn ${turnCount} done`);
	});

	// -- 对危险工具调用使用 select --

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;

		const command = event.input.command as string;
		const isDangerous = /\brm\s+(-rf?|--recursive)/i.test(command) || /\bsudo\b/i.test(command);

		if (isDangerous) {
			if (!ctx.hasUI) {
				return { block: true, reason: "Dangerous command blocked (no UI)" };
			}

			const choice = await ctx.ui.select(`Dangerous command: ${command}`, ["Allow", "Block"]);
			if (choice !== "Allow") {
				ctx.ui.notify("Command blocked by user", "warning");
				return { block: true, reason: "Blocked by user" };
			}
			ctx.ui.notify("Command allowed", "info");
		}

		return undefined;
	});

	// -- confirm on session clear --

	pi.on("session_before_switch", async (event, ctx) => {
		if (event.reason !== "new") return;
		if (!ctx.hasUI) return;

		const confirmed = await ctx.ui.confirm("Clear session?", "All messages will be lost.");
		if (!confirmed) {
			ctx.ui.notify("Clear cancelled", "info");
			return { cancel: true };
		}
	});

	// -- input via command --

	pi.registerCommand("rpc-input", {
		description: "Prompt for text input (demonstrates ctx.ui.input in RPC)",
		handler: async (_args, ctx) => {
			const value = await ctx.ui.input("Enter a value", "type something...");
			if (value) {
				ctx.ui.notify(`You entered: ${value}`, "info");
			} else {
				ctx.ui.notify("Input cancelled", "info");
			}
		},
	});

	// -- editor via command --

	pi.registerCommand("rpc-editor", {
		description: "Open multi-line editor (demonstrates ctx.ui.editor in RPC)",
		handler: async (_args, ctx) => {
			const text = await ctx.ui.editor("Edit some text", "Line 1\nLine 2\nLine 3");
			if (text) {
				ctx.ui.notify(`Editor submitted (${text.split("\n").length} lines)`, "info");
			} else {
				ctx.ui.notify("Editor cancelled", "info");
			}
		},
	});

	// -- setEditorText via command --

	pi.registerCommand("rpc-prefill", {
		description: "Prefill the input editor (demonstrates ctx.ui.setEditorText in RPC)",
		handler: async (_args, ctx) => {
			ctx.ui.setEditorText("This text was set by the rpc-demo extension.");
			ctx.ui.notify("Editor prefilled", "info");
		},
	});
}
