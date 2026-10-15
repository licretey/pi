/**
 * 模态编辑器：类似 Vim 的模态编辑示例。
 *
 * 用法：pi --extension ./examples/extensions/modal-editor.ts
 *
 * - Escape：从插入模式切换到普通模式（普通模式下会中止智能体）
 * - i：从普通模式切换到插入模式
 * - hjkl：在普通模式下导航
 * - ctrl+c、ctrl+d 等按键在两种模式下均有效
 */

import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// 普通模式按键映射：按键 -> 转义序列（切换模式时为 null）。
const NORMAL_KEYS: Record<string, string | null> = {
	h: "\x1b[D", // left
	j: "\x1b[B", // down
	k: "\x1b[A", // up
	l: "\x1b[C", // right
	"0": "\x01", // line start
	$: "\x05", // line end
	x: "\x1b[3~", // delete char
	i: null, // insert mode
	a: null, // append (insert + right)
};

class ModalEditor extends CustomEditor {
	private mode: "normal" | "insert" = "insert";

	handleInput(data: string): void {
		// Escape 会切换到普通模式；若已处于普通模式，则交由应用处理。
		if (matchesKey(data, "escape")) {
			if (this.mode === "insert") {
				this.mode = "normal";
			} else {
				super.handleInput(data); // abort agent, etc.
			}
			return;
		}

		// 插入模式：将所有输入原样传递。
		if (this.mode === "insert") {
			super.handleInput(data);
			return;
		}

		// 普通模式：检查按键映射。
		if (data in NORMAL_KEYS) {
			const seq = NORMAL_KEYS[data];
			if (data === "i") {
				this.mode = "insert";
			} else if (data === "a") {
				this.mode = "insert";
				super.handleInput("\x1b[C"); // move right first
			} else if (seq) {
				super.handleInput(seq);
			}
			return;
		}

		// 控制序列（ctrl+c 等）交给父类处理，可打印字符则忽略。
		if (data.length === 1 && data.charCodeAt(0) >= 32) return;
		super.handleInput(data);
	}

	render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) return lines;

		// 在底部边框添加模式指示器。
		const label = this.mode === "normal" ? " NORMAL " : " INSERT ";
		const last = lines.length - 1;
		if (visibleWidth(lines[last]!) >= label.length) {
			lines[last] = truncateToWidth(lines[last]!, width - label.length, "") + label;
		}
		return lines;
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setEditorComponent((tui, theme, kb) => new ModalEditor(tui, theme, kb));
	});
}
