import assert from "node:assert";
import { describe, it } from "node:test";
import type { Component, TUI } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class SimpleContent implements Component {
	private lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	render(): string[] {
		return this.lines;
	}
	invalidate() {}
}

class SimpleOverlay implements Component {
	render(): string[] {
		return ["OVERLAY_TOP", "OVERLAY_MID", "OVERLAY_BOT"];
	}
	invalidate() {}
}

describe("TUI overlay with short content", () => {
	it("should render overlay when content is shorter than terminal height", async () => {
		// 终端有 24 行，但内容只有 3 行。
		const terminal = new VirtualTerminal(80, 24);
		const tui: TUI = new TuiMainScreen(terminal);

		// 内容只有 3 行。
		tui.addChild(new SimpleContent(["Line 1", "Line 2", "Line 3"]));

		// 居中显示覆盖层；在 24 行的终端中应位于第 10 行附近。
		const overlay = new SimpleOverlay();
		tui.showOverlay(overlay);

		// 触发渲染。
		tui.start();
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		const hasOverlay = viewport.some((line) => line.includes("OVERLAY"));

		console.log("Terminal rows:", terminal.rows);
		console.log("Content lines: 3");
		console.log("Overlay visible:", hasOverlay);

		if (!hasOverlay) {
			console.log("\nViewport contents:");
			for (let i = 0; i < viewport.length; i++) {
				console.log(`  [${i}]: "${viewport[i]}"`);
			}
		}

		assert.ok(hasOverlay, "Overlay should be visible when content is shorter than terminal");

		tui.stop();
	});
});
