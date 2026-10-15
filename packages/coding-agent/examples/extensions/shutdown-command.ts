/**
 * 关闭命令扩展。
 *
 * 添加 /quit 命令，使扩展能够触发正常关闭。
 * 演示扩展如何使用 ctx.shutdown() 正常退出 pi。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
	// 注册 /quit 命令以正常退出 pi。
	pi.registerCommand("quit", {
		description: "Exit pi cleanly",
		handler: async (_args, ctx) => {
			ctx.shutdown();
		},
	});

	// 也可以创建一个在完成工作后关闭程序的工具。
	pi.registerTool({
		name: "finish_and_exit",
		label: "Finish and Exit",
		description: "Complete a task and exit pi",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			// 在此执行最后的收尾工作……
			// 请求正常关闭（会延迟到智能体空闲时执行）。
			ctx.shutdown();

			// 关闭发生前，此返回值会先发送给 LLM。
			return {
				content: [{ type: "text", text: "Shutdown requested. Exiting after this response." }],
				details: {},
			};
		},
	});

	// 也可以创建带参数的复杂工具。
	pi.registerTool({
		name: "deploy_and_exit",
		label: "Deploy and Exit",
		description: "Deploy the application and exit pi",
		parameters: Type.Object({
			environment: Type.String({ description: "Target environment (e.g., production, staging)" }),
		}),
		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: `Deploying to ${params.environment}...` }], details: {} });

			// 示例部署逻辑。
			// const result = await pi.exec("npm", ["run", "deploy", params.environment], { signal });

			// 操作成功后请求正常关闭。
			onUpdate?.({ content: [{ type: "text", text: "Deployment complete, exiting..." }], details: {} });
			ctx.shutdown();

			return {
				content: [{ type: "text", text: "Done! Shutdown requested." }],
				details: { environment: params.environment },
			};
		},
	});
}
