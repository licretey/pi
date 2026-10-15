import { randomUUID } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { getNativeClipboard } from "@earendil-works/pi-tui";
import { runClipboardCommand } from "./clipboard-command.ts";
import { isWSL } from "./wsl.ts";

const MAX_OSC52_ENCODED_LENGTH = 100_000;

function isRemoteSession(env: NodeJS.ProcessEnv): boolean {
	return Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.MOSH_CONNECTION);
}

function emitOsc52(text: string): boolean {
	const encoded = Buffer.from(text).toString("base64");
	if (encoded.length > MAX_OSC52_ENCODED_LENGTH) {
		return false;
	}
	process.stdout.write(`\x1b]52;c;${encoded}\x07`);
	return true;
}

/**
 * 未启用 WSLg 的 WSL 没有 Linux 图形界面，因此通过互操作功能写入 Windows 剪贴板。
 * PowerShell 从文件读取文本，因为 `clip.exe` 和 PowerShell 的标准输入会按控制台代码页
 * 解码管道字节，导致非 ASCII 的 UTF-8 字符损坏。
 */
async function copyViaWindowsClipboard(text: string): Promise<boolean> {
	const tmpFile = join(tmpdir(), `pi-wsl-clip-${randomUUID()}.txt`);
	try {
		writeFileSync(tmpFile, text, { encoding: "utf8", mode: 0o600 });
		const winPath = (await runClipboardCommand("wslpath", ["-w", tmpFile], { timeoutMs: 1000 }))
			?.toString("utf8")
			.trim();
		if (!winPath) return false;
		const script = `Set-Clipboard -Value ([System.IO.File]::ReadAllText('${winPath.replaceAll("'", "''")}', [System.Text.Encoding]::UTF8))`;
		const result = await runClipboardCommand("powershell.exe", ["-NoProfile", "-Command", script], {
			timeoutMs: 5000,
		});
		return result !== undefined;
	} catch {
		return false;
	} finally {
		try {
			unlinkSync(tmpFile);
		} catch {
			// 临时文件可能尚未创建。
		}
	}
}

/** 读取系统剪贴板中的纯文本。 */
export async function readClipboardText(): Promise<string | null> {
	const commands: [string, string[]][] = [];
	// Termux 报告的平台是 "android"，而不是 "linux"（#10391）。
	if (process.env.TERMUX_VERSION) commands.push(["termux-clipboard-get", []]);
	if (platform() === "linux") {
		if (process.env.WAYLAND_DISPLAY) commands.push(["wl-paste", ["--no-newline", "--type", "text"]]);
		if (process.env.DISPLAY) {
			commands.push(["xclip", ["-selection", "clipboard", "-out"]], ["xsel", ["--clipboard", "--output"]]);
		}
	}
	for (const [command, args] of commands) {
		const bytes = await runClipboardCommand(command, args, { timeoutMs: 5000 });
		if (bytes !== undefined) return bytes.toString("utf8") || null;
	}
	try {
		return (await getNativeClipboard()?.getText()) || null;
	} catch {
		return null;
	}
}

/** 从原生剪贴板读取文件路径，例如从 Finder 复制的文件。 */
export async function readClipboardFilePaths(): Promise<string[] | null> {
	const paths = await getNativeClipboard()?.getFilePaths?.();
	return paths?.length ? paths : null;
}

export async function copyToClipboard(text: string): Promise<void> {
	const p = platform();
	const env = process.env;
	let copied = false;
	// 先直接写入剪贴板，再发送 OSC 52，避免终端与原生写入操作发生竞态。
	// Linux 工具在此调用返回后仍会持有剪贴板选择区。
	if (p !== "linux") {
		try {
			const clipboard = getNativeClipboard();
			if (clipboard?.setText) {
				await clipboard.setText(text);
				copied = true;
			}
		} catch {
			// 接下来尝试平台命令。
		}
	}
	if (!copied) {
		const commands: [string, string[]][] = [];
		if (p === "darwin") commands.push(["pbcopy", []]);
		else if (p === "win32") commands.push(["clip", []]);
		else {
			if (env.TERMUX_VERSION) commands.push(["termux-clipboard-set", []]);
			if (env.WAYLAND_DISPLAY) commands.push(["wl-copy", []]);
			if (env.DISPLAY) {
				commands.push(["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]]);
			}
		}
		for (const [command, args] of commands) {
			if ((await runClipboardCommand(command, args, { input: text, timeoutMs: 5000 })) !== undefined) {
				copied = true;
				break;
			}
		}
	}
	let osc52Emitted = false;
	if (!copied && p === "linux" && isWSL(env)) {
		// Windows Terminal 支持 OSC 52；优先使用它，避免较慢的 PowerShell 往返调用。
		if (env.WT_SESSION) osc52Emitted = emitOsc52(text);
		copied = osc52Emitted || (await copyViaWindowsClipboard(text));
	}
	// 无法确认 OSC 52 是否成功，因此有图形显示的桌面会话会报告失败
	//（#9618）。没有图形显示时，终端是唯一的剪贴板通道（例如容器和
	// 未启用 WSLg 的 WSL）；远程会话则始终发送 OSC 52，以访问客户端剪贴板。
	const headless = p === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY && !env.TERMUX_VERSION;
	let oversized = false;
	if (!osc52Emitted && (isRemoteSession(env) || (!copied && headless))) {
		if (emitOsc52(text)) copied = true;
		else oversized = true;
	}
	if (copied) return;
	if (oversized) throw new Error("Clipboard unavailable: text exceeds the OSC 52 size limit");
	if (env.TERMUX_VERSION) {
		throw new Error("Clipboard unavailable: install the Termux:API app and `termux-api` package");
	}
	if (p === "linux") {
		if (env.WAYLAND_DISPLAY) {
			throw new Error("Clipboard unavailable: install `wl-clipboard` (`wl-copy`) or check Wayland access");
		}
		if (env.DISPLAY) {
			throw new Error("Clipboard unavailable: install `xclip` or `xsel`, or check X11 access");
		}
	}
	throw new Error("Clipboard unavailable");
}
