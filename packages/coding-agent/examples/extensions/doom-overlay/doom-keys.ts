/**
 * DOOM 按键码（定义于 doomkeys.h）。
 */
export const DoomKeys = {
	KEY_RIGHTARROW: 0xae,
	KEY_LEFTARROW: 0xac,
	KEY_UPARROW: 0xad,
	KEY_DOWNARROW: 0xaf,
	KEY_STRAFE_L: 0xa0,
	KEY_STRAFE_R: 0xa1,
	KEY_USE: 0xa2,
	KEY_FIRE: 0xa3,
	KEY_ESCAPE: 27,
	KEY_ENTER: 13,
	KEY_TAB: 9,
	KEY_F1: 0x80 + 0x3b,
	KEY_F2: 0x80 + 0x3c,
	KEY_F3: 0x80 + 0x3d,
	KEY_F4: 0x80 + 0x3e,
	KEY_F5: 0x80 + 0x3f,
	KEY_F6: 0x80 + 0x40,
	KEY_F7: 0x80 + 0x41,
	KEY_F8: 0x80 + 0x42,
	KEY_F9: 0x80 + 0x43,
	KEY_F10: 0x80 + 0x44,
	KEY_F11: 0x80 + 0x57,
	KEY_F12: 0x80 + 0x58,
	KEY_BACKSPACE: 127,
	KEY_PAUSE: 0xff,
	KEY_EQUALS: 0x3d,
	KEY_MINUS: 0x2d,
	KEY_RSHIFT: 0x80 + 0x36,
	KEY_RCTRL: 0x80 + 0x1d,
	KEY_RALT: 0x80 + 0x38,
} as const;

import { Key, matchesKey, parseKey } from "@earendil-works/pi-tui";

/**
 * 将终端按键输入映射为 DOOM 按键码。
 * 同时支持原始终端输入和 Kitty 协议序列。
 */
export function mapKeyToDoom(data: string): number[] {
	// 方向键。
	if (matchesKey(data, Key.up)) return [DoomKeys.KEY_UPARROW];
	if (matchesKey(data, Key.down)) return [DoomKeys.KEY_DOWNARROW];
	if (matchesKey(data, Key.right)) return [DoomKeys.KEY_RIGHTARROW];
	if (matchesKey(data, Key.left)) return [DoomKeys.KEY_LEFTARROW];

	// WASD：同时检查原始字符和 Kitty 协议序列。
	if (data === "w" || matchesKey(data, "w")) return [DoomKeys.KEY_UPARROW];
	if (data === "W" || matchesKey(data, Key.shift("w"))) return [DoomKeys.KEY_UPARROW, DoomKeys.KEY_RSHIFT];
	if (data === "s" || matchesKey(data, "s")) return [DoomKeys.KEY_DOWNARROW];
	if (data === "S" || matchesKey(data, Key.shift("s"))) return [DoomKeys.KEY_DOWNARROW, DoomKeys.KEY_RSHIFT];
	if (data === "a" || matchesKey(data, "a")) return [DoomKeys.KEY_STRAFE_L];
	if (data === "A" || matchesKey(data, Key.shift("a"))) return [DoomKeys.KEY_STRAFE_L, DoomKeys.KEY_RSHIFT];
	if (data === "d" || matchesKey(data, "d")) return [DoomKeys.KEY_STRAFE_R];
	if (data === "D" || matchesKey(data, Key.shift("d"))) return [DoomKeys.KEY_STRAFE_R, DoomKeys.KEY_RSHIFT];

	// F 键用于开火。
	if (data === "f" || data === "F" || matchesKey(data, "f") || matchesKey(data, Key.shift("f"))) {
		return [DoomKeys.KEY_FIRE];
	}

	// 使用或打开。
	if (data === " " || matchesKey(data, Key.space)) return [DoomKeys.KEY_USE];

	// 菜单和界面按键。
	if (matchesKey(data, Key.enter)) return [DoomKeys.KEY_ENTER];
	if (matchesKey(data, Key.escape)) return [DoomKeys.KEY_ESCAPE];
	if (matchesKey(data, Key.tab)) return [DoomKeys.KEY_TAB];
	if (matchesKey(data, Key.backspace)) return [DoomKeys.KEY_BACKSPACE];

	// Ctrl 按键（Ctrl+C 除外）用于开火（兼容旧行为）。
	const parsed = parseKey(data);
	if (parsed?.startsWith("ctrl+") && parsed !== "ctrl+c") {
		return [DoomKeys.KEY_FIRE];
	}
	if (data.length === 1 && data.charCodeAt(0) < 32 && data !== "\x03") {
		return [DoomKeys.KEY_FIRE];
	}

	// 使用数字 0-9 选择武器。
	if (data >= "0" && data <= "9") return [data.charCodeAt(0)];

	// 使用加号和减号调整屏幕尺寸。
	if (data === "+" || data === "=") return [DoomKeys.KEY_EQUALS];
	if (data === "-") return [DoomKeys.KEY_MINUS];

	// 提示时使用 Y/N。
	if (data === "y" || data === "Y" || matchesKey(data, "y") || matchesKey(data, Key.shift("y"))) {
		return ["y".charCodeAt(0)];
	}
	if (data === "n" || data === "N" || matchesKey(data, "n") || matchesKey(data, Key.shift("n"))) {
		return ["n".charCodeAt(0)];
	}

	// 其他可打印字符（用于输入秘籍）。
	if (data.length === 1 && data.charCodeAt(0) >= 32) {
		return [data.toLowerCase().charCodeAt(0)];
	}

	return [];
}
