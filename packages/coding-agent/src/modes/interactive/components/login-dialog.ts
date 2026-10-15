import type { AuthInfoLink, OAuthDeviceCodeInfo } from "@earendil-works/pi-ai";
import { Container, type Focusable, getKeybindings, Input, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import { openBrowser } from "../../../utils/open-browser.ts";
import { theme } from "../theme/theme.ts";
import { AuthUrlComponent } from "./auth-url.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint } from "./keybinding-hints.ts";

/**
 * 登录对话框组件；OAuth 登录流程期间替代编辑器。
 */
export class LoginDialogComponent extends Container implements Focusable {
	private contentContainer: Container;
	private input: Input;
	private tui: TUI;
	/** 当前显示的登录 URL；`app.message.copy` 会复制此 URL。 */
	private authUrl?: AuthUrlComponent;
	private abortController = new AbortController();
	private inputResolver?: (value: string) => void;
	private inputRejecter?: (error: Error) => void;
	private onComplete: (success: boolean, message?: string) => void;

	// Focusable 接口实现：将焦点状态传递给输入框，以正确定位输入法光标。
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	constructor(
		tui: TUI,
		providerId: string,
		onComplete: (success: boolean, message?: string) => void,
		providerNameOverride?: string,
		titleOverride?: string,
	) {
		super();
		this.tui = tui;
		this.onComplete = onComplete;

		const providerName = providerNameOverride || providerId;
		const title = titleOverride ?? `Login to ${providerName}`;

		// 顶部边框。
		this.addChild(new DynamicBorder());

		// 标题。
		this.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));

		// 动态内容区域。
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		// 输入框（始终存在，按需使用）。
		this.input = new Input();
		this.input.onSubmit = () => {
			if (this.inputResolver) {
				const value = this.input.getValue();
				this.replaceInputWithSubmittedText(value);
				this.inputResolver(value);
				this.inputResolver = undefined;
				this.inputRejecter = undefined;
			}
		};
		this.input.onEscape = () => {
			this.cancel();
		};

		// 底部边框。
		this.addChild(new DynamicBorder());
	}

	get signal(): AbortSignal {
		return this.abortController.signal;
	}

	private replaceInputWithSubmittedText(value: string): void {
		this.contentContainer.children = this.contentContainer.children.map((child) =>
			child === this.input ? new Text(`> ${value}`, 0, 0) : child,
		);
	}

	private cancel(): void {
		this.abortController.abort();
		if (this.inputRejecter) {
			this.inputRejecter(new Error("Login cancelled"));
			this.inputResolver = undefined;
			this.inputRejecter = undefined;
		}
		this.onComplete(false, "Login cancelled");
	}

	/**
	 * 由 onAuth 回调调用，用于显示 URL 和可选的操作说明。
	 */
	showAuth(url: string, instructions?: string): void {
		this.contentContainer.clear();
		this.contentContainer.addChild(new Spacer(1));
		this.authUrl = new AuthUrlComponent(this.tui, url);
		this.contentContainer.addChild(this.authUrl);

		if (instructions) {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(new Text(theme.fg("warning", instructions), 1, 0));
		}

		openBrowser(url);
		this.tui.requestRender();
	}

	/**
	 * 由 onDeviceCode 回调调用，用于显示 URL 和用户代码。
	 */
	showDeviceCode(info: OAuthDeviceCodeInfo): void {
		this.authUrl = undefined;
		this.contentContainer.clear();
		this.contentContainer.addChild(new Spacer(1));
		const linkedUrl = `\x1b]8;;${info.verificationUri}\x07${info.verificationUri}\x1b]8;;\x07`;
		this.contentContainer.addChild(new Text(theme.fg("accent", linkedUrl), 1, 0));

		const clickHint = process.platform === "darwin" ? "Cmd+click to open" : "Ctrl+click to open";
		const hyperlink = `\x1b]8;;${info.verificationUri}\x07${clickHint}\x1b]8;;\x07`;
		this.contentContainer.addChild(new Text(theme.fg("dim", hyperlink), 1, 0));
		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(new Text(theme.fg("warning", `Enter code: ${info.userCode}`), 1, 0));

		this.tui.requestRender();
	}

	/**
	 * 显示输入框，供用户手动输入代码或 URL（用于回调服务器类型的提供商）。
	 */
	showManualInput(prompt: string): Promise<string> {
		this.input.setValue("");
		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(new Text(theme.fg("dim", prompt), 1, 0));
		this.contentContainer.addChild(this.input);
		this.contentContainer.addChild(new Text(`(${keyHint("tui.select.cancel", "to cancel")})`, 1, 0));
		this.tui.requestRender();

		return new Promise((resolve, reject) => {
			this.inputResolver = resolve;
			this.inputRejecter = reject;
		});
	}

	/**
	 * 由 onPrompt 回调调用，显示提示并等待输入。
	 * 注意：不会清除现有内容，而是追加内容（保留 showAuth 显示的 URL）。
	 */
	showPrompt(message: string, placeholder?: string): Promise<string> {
		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(new Text(theme.fg("text", message), 1, 0));
		if (placeholder) {
			this.contentContainer.addChild(new Text(theme.fg("dim", `e.g., ${placeholder}`), 1, 0));
		}
		this.contentContainer.addChild(this.input);
		this.contentContainer.addChild(
			new Text(
				`(${keyHint("tui.select.cancel", "to cancel,")} ${keyHint("tui.select.confirm", "to submit")})`,
				1,
				0,
			),
		);

		this.input.setValue("");
		this.tui.requestRender();

		return new Promise((resolve, reject) => {
			this.inputResolver = resolve;
			this.inputRejecter = reject;
		});
	}

	/** 在下一步登录操作前显示说明文本。 */
	showDetails(lines: string[]): void {
		this.authUrl = undefined;
		this.contentContainer.clear();
		this.contentContainer.addChild(new Spacer(1));
		for (const line of lines) {
			this.contentContainer.addChild(new Text(line, 1, 0));
		}
		this.tui.requestRender();
	}

	/** 显示由提供商提供的说明和链接，但不启动身份验证回调流程。 */
	showInfo(message: string, links: readonly AuthInfoLink[] = [], showCloseHint = false): void {
		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(new Text(theme.fg("text", message), 1, 0));
		for (const link of links) {
			const text = link.label ? `${link.label}: ${link.url}` : link.url;
			const hyperlink = `\x1b]8;;${link.url}\x07${text}\x1b]8;;\x07`;
			this.contentContainer.addChild(new Text(theme.fg("accent", hyperlink), 1, 0));
		}
		if (showCloseHint) {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(new Text(`(${keyHint("tui.select.cancel", "to close")})`, 1, 0));
		}
		this.tui.requestRender();
	}

	/**
	 * 显示等待消息（用于 GitHub Copilot 等轮询流程）。
	 */
	showWaiting(message: string): void {
		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(new Text(theme.fg("dim", message), 1, 0));
		this.contentContainer.addChild(new Text(`(${keyHint("tui.select.cancel", "to cancel")})`, 1, 0));
		this.tui.requestRender();
	}

	/**
	 * 由 onProgress 回调调用。
	 */
	showProgress(message: string): void {
		this.contentContainer.addChild(new Text(theme.fg("dim", message), 1, 0));
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		const kb = getKeybindings();

		if (kb.matches(data, "tui.select.cancel")) {
			this.cancel();
			return;
		}
		if (this.authUrl && kb.matches(data, "app.message.copy")) {
			void this.authUrl.copy();
			return;
		}

		// 将输入交给输入框处理。
		this.input.handleInput(data);
	}
}
