import { Container, hyperlink, Text, type TUI } from "@earendil-works/pi-tui";
import { copyToClipboard } from "../../../utils/clipboard.ts";
import { theme } from "../theme/theme.ts";
import { keyHint } from "./keybinding-hints.ts";

/**
 * 显示登录链接及点击、复制提示。由于长链接会自动换行，在 SSH、tmux 等环境中通常无法整体选中或点击，
 * 因此宿主在按下 `app.message.copy` 时会调用 `copy()`。
 */
export class AuthUrlComponent extends Container {
	readonly url: string;
	private readonly tui: TUI;
	private readonly hint: Text;

	constructor(tui: TUI, url: string) {
		super();
		this.tui = tui;
		this.url = url;
		this.addChild(new Text(theme.fg("accent", hyperlink(url, url)), 1, 0));
		this.hint = new Text("", 1, 0);
		this.addChild(this.hint);
		this.setHint(keyHint("app.message.copy", "to copy"));
	}

	private setHint(suffix: string): void {
		const clickHint = process.platform === "darwin" ? "Cmd+click to open" : "Ctrl+click to open";
		this.hint.setText(`${theme.fg("dim", hyperlink(clickHint, this.url))} ${theme.fg("dim", "•")} ${suffix}`);
		this.tui.requestRender();
	}

	async copy(): Promise<void> {
		try {
			await copyToClipboard(this.url);
			this.setHint(theme.fg("success", "Copied URL to clipboard"));
		} catch (error) {
			this.setHint(theme.fg("error", error instanceof Error ? error.message : String(error)));
		}
	}
}
