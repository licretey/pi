/**
 * `/mcp` 管理界面：服务器连接期间会重新构建的菜单、只读状态页面，以及接受粘贴重定向 URL 的登录页面。
 */

import {
	type Component,
	Container,
	type Focusable,
	Input,
	type SelectItem,
	SelectList,
	Spacer,
	Text,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { ExtensionCommandContext } from "../../core/extensions/types.ts";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import { AuthUrlComponent } from "../../modes/interactive/components/auth-url.ts";
import { DynamicBorder } from "../../modes/interactive/components/dynamic-border.ts";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import { getSelectListTheme, type Theme } from "../../modes/interactive/theme/theme.ts";

export interface McpMenu {
	title: string;
	/** 显示在标题下方。 */
	details?: string;
	/** 显示在详情下方，并使用错误颜色。 */
	error?: string;
	items: SelectItem[];
	/** 没有条目时显示。 */
	empty?: string;
	/** 菜单打开时默认选中项的值。 */
	selected?: string;
	/** 确认键的操作说明，用于显示按键提示。 */
	confirmLabel: string;
	/** 取消键的操作说明，用于显示按键提示。 */
	cancelLabel: string;
}

export interface McpUi {
	/**
	 * 显示菜单并返回所选条目的值；取消时返回 undefined。每次发生变化时，`subscribe`
	 * 都会重建菜单并保留当前选中项。
	 */
	menu(build: () => McpMenu, subscribe?: (listener: () => void) => () => void): Promise<string | undefined>;
	/** 操作期间显示消息。若提供 `onCancel`，按取消键时会调用它。 */
	status(title: string, message: string, onCancel?: () => void): void;
	/**
	 * 显示授权 URL，并等待用户粘贴重定向 URL。取消操作或 `signal` 中止时（浏览器已到达回调地址），
	 * 返回 undefined。
	 */
	redirectUrl(title: string, authorizationUrl: string, signal: AbortSignal): Promise<string | undefined>;
}

function frame(theme: Theme, title: string, body: Component[], footer?: string): Container {
	const container = new Container();
	container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
	container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
	for (const child of body) container.addChild(child);
	if (footer) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", footer), 1, 0));
	}
	container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
	return container;
}

const MAX_VISIBLE_ITEMS = 12;

export class McpManagerView implements McpUi, Component, Focusable {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private content: Container;
	private inputHandler: ((data: string) => void) | undefined;
	private inputTarget: Focusable | undefined;
	private _focused = false;

	constructor(tui: TUI, theme: Theme, keybindings: KeybindingsManager) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.content = frame(theme, "MCP servers", [new Text(theme.fg("muted", "Loading…"), 1, 1)]);
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		if (this.inputTarget) this.inputTarget.focused = value;
	}

	private setContent(content: Container, inputHandler?: (data: string) => void, inputTarget?: Focusable): void {
		if (this.inputTarget) this.inputTarget.focused = false;
		this.content = content;
		this.inputHandler = inputHandler;
		this.inputTarget = inputTarget;
		if (this.inputTarget) this.inputTarget.focused = this._focused;
		this.tui.requestRender();
	}

	menu(build: () => McpMenu, subscribe?: (listener: () => void) => () => void): Promise<string | undefined> {
		return new Promise((resolve) => {
			let unsubscribe: (() => void) | undefined;
			let settled = false;
			const finish = (value: string | undefined) => {
				if (settled) return;
				settled = true;
				unsubscribe?.();
				resolve(value);
			};
			let selected: string | undefined;
			const render = () => {
				const menu = build();
				const wanted = selected ?? menu.selected;
				const body: Component[] = [];
				if (menu.details) body.push(new Text(this.theme.fg("muted", menu.details), 1, 0));
				if (menu.error) body.push(new Text(this.theme.fg("error", menu.error), 1, 0));
				body.push(new Spacer(1));
				const footer = `${keyHint("tui.select.confirm", menu.confirmLabel)} • ${keyHint("tui.select.cancel", menu.cancelLabel)}`;
				if (menu.items.length === 0) {
					body.push(new Text(this.theme.fg("muted", menu.empty ?? "Nothing to show."), 1, 0));
					this.setContent(
						frame(this.theme, menu.title, body, keyHint("tui.select.cancel", menu.cancelLabel)),
						(data) => {
							if (this.keybindings.matches(data, "tui.select.cancel")) finish(undefined);
						},
					);
					return;
				}
				const list = new SelectList(
					menu.items,
					Math.min(menu.items.length, MAX_VISIBLE_ITEMS),
					getSelectListTheme(),
				);
				const index = menu.items.findIndex((item) => item.value === wanted);
				if (index !== -1) list.setSelectedIndex(index);
				selected = list.getSelectedItem()?.value;
				list.onSelectionChange = (item) => {
					selected = item.value;
				};
				list.onSelect = (item) => finish(item.value);
				list.onCancel = () => finish(undefined);
				body.push(list);
				this.setContent(frame(this.theme, menu.title, body, footer), (data) => list.handleInput(data));
			};
			render();
			unsubscribe = subscribe?.(() => {
				if (!settled) render();
			});
		});
	}

	status(title: string, message: string, onCancel?: () => void): void {
		const body = [new Spacer(1), new Text(this.theme.fg("muted", message), 1, 0)];
		if (!onCancel) {
			this.setContent(frame(this.theme, title, body));
			return;
		}
		this.setContent(frame(this.theme, title, body, keyHint("tui.select.cancel", "cancel")), (data) => {
			if (this.keybindings.matches(data, "tui.select.cancel")) onCancel();
		});
	}

	redirectUrl(title: string, authorizationUrl: string, signal: AbortSignal): Promise<string | undefined> {
		return new Promise((resolve) => {
			let settled = false;
			const finish = (value: string | undefined) => {
				if (settled) return;
				settled = true;
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			};
			const onAbort = () => finish(undefined);
			if (signal.aborted) {
				finish(undefined);
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
			const input = new Input();
			const link = new AuthUrlComponent(this.tui, authorizationUrl);
			const body: Component[] = [
				new Spacer(1),
				new Text(this.theme.fg("muted", "Approve access in your browser. If it did not open, visit:"), 1, 0),
				link,
				new Spacer(1),
				new Text(
					this.theme.fg("muted", "If the browser runs on another machine, paste the URL it was redirected to:"),
					1,
					0,
				),
				input,
			];
			this.setContent(
				frame(
					this.theme,
					title,
					body,
					`${keyHint("tui.select.confirm", "submit")} • ${keyHint("tui.select.cancel", "cancel")}`,
				),
				(data) => {
					if (this.keybindings.matches(data, "tui.select.confirm")) {
						const value = input.getValue().trim();
						if (value) finish(value);
						return;
					}
					if (this.keybindings.matches(data, "tui.select.cancel")) {
						finish(undefined);
						return;
					}
					if (this.keybindings.matches(data, "app.message.copy")) {
						void link.copy();
						return;
					}
					input.handleInput(data);
				},
				input,
			);
		});
	}

	handleInput(data: string): void {
		this.inputHandler?.(data);
		this.tui.requestRender();
	}

	render(width: number): string[] {
		return this.content
			.render(width)
			.map((line) => (visibleWidth(line) > width ? truncateToWidth(line, width, "") : line));
	}

	invalidate(): void {
		this.content.invalidate();
	}
}

/** 在管理器视图中运行 `manage`，直到其返回。 */
export async function showMcpManager(
	ctx: ExtensionCommandContext,
	manage: (ui: McpUi) => Promise<void>,
): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
		const view = new McpManagerView(tui, theme, keybindings);
		void manage(view).then(
			() => done(),
			(error: unknown) => {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				done();
			},
		);
		return view;
	});
}
