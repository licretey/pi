/**
 * 工具扩展
 *
 * 提供 /tools 命令，以交互方式启用或禁用工具。
 * 工具选择会在会话重新加载后保留，并遵循会话分支导航。
 *
 * 用法：
 * 1. 将此文件复制到 ~/.pi/agent/extensions/ 或项目的 .pi/extensions/ 目录
 * 2. 使用 /tools 打开工具选择器
 */

import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList } from "@earendil-works/pi-tui";

// 持久化到会话的状态
interface ToolsState {
	enabledTools: string[];
}

export default function toolsExtension(pi: ExtensionAPI) {
	// 跟踪已启用的工具
	let enabledTools: Set<string> = new Set();
	let allTools: ToolInfo[] = [];

	// 持久化当前状态
	function persistState() {
		pi.appendEntry<ToolsState>("tools-config", {
			enabledTools: Array.from(enabledTools),
		});
	}

	// 应用当前工具选择
	function applyTools() {
		pi.setActiveTools(Array.from(enabledTools));
	}

	// 查找当前分支中最后一条 tools-config 记录
	function restoreFromBranch(ctx: ExtensionContext) {
		allTools = pi.getAllTools();

		// 仅获取当前分支中的条目
		const branchEntries = ctx.sessionManager.getBranch();
		let savedTools: string[] | undefined;

		for (const entry of branchEntries) {
			if (entry.type === "custom" && entry.customType === "tools-config") {
				const data = entry.data as ToolsState | undefined;
				if (data?.enabledTools) {
					savedTools = data.enabledTools;
				}
			}
		}

		if (savedTools) {
			// 恢复已保存的工具选择（仅保留仍然存在的工具）
			const allToolNames = allTools.map((t) => t.name);
			enabledTools = new Set(savedTools.filter((t: string) => allToolNames.includes(t)));
			applyTools();
		} else {
			// 没有已保存的状态，将其与当前活动工具同步
			enabledTools = new Set(pi.getActiveTools());
		}
	}

	// 注册 /tools 命令
	pi.registerCommand("tools", {
		description: "Enable/disable tools",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/tools requires TUI mode", "error");
				return;
			}

			// 刷新工具列表
			allTools = pi.getAllTools();

			await ctx.ui.custom((tui, theme, _kb, done) => {
				// 为每个工具创建设置项
				const items: SettingItem[] = allTools.map((tool) => ({
					id: tool.name,
					label: tool.name,
					currentValue: enabledTools.has(tool.name) ? "enabled" : "disabled",
					values: ["enabled", "disabled"],
				}));

				const container = new Container();
				container.addChild(
					new (class {
						render(_width: number) {
							return [theme.fg("accent", theme.bold("Tool Configuration")), ""];
						}
						invalidate() {}
					})(),
				);

				const settingsList = new SettingsList(
					items,
					Math.min(items.length + 2, 15),
					getSettingsListTheme(),
					(id, newValue) => {
						// 更新启用状态并立即应用
						if (newValue === "enabled") {
							enabledTools.add(id);
						} else {
							enabledTools.delete(id);
						}
						applyTools();
						persistState();
					},
					() => {
						// 关闭对话框
						done(undefined);
					},
				);

				container.addChild(settingsList);

				const component = {
					render(width: number) {
						return container.render(width);
					},
					invalidate() {
						container.invalidate();
					},
					handleInput(data: string) {
						settingsList.handleInput?.(data);
						tui.requestRender();
					},
				};

				return component;
			});
		},
	});

	// 会话开始时恢复状态
	pi.on("session_start", async (_event, ctx) => {
		restoreFromBranch(ctx);
	});

	// 导航会话树时恢复状态
	pi.on("session_tree", async (_event, ctx) => {
		restoreFromBranch(ctx);
	});
}
