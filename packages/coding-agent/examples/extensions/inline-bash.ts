/**
 * 行内 Bash 扩展：展开用户提示中的行内 Bash 命令。
 *
 * 使用此扩展启动 pi：
 *   pi -e ./examples/extensions/inline-bash.ts
 *
 * 然后输入包含行内 Bash 命令的提示：
 *   What's in !{pwd}?
 *   当前分支为 !{git branch --show-current}，工作区状态为：!{git status --short}
 *   My node version is !{node --version}
 *
 * 提示发送给智能体之前，!{command} 模式会先执行，并替换为命令输出。
 *
 * 注意：普通的 !command 语法（整行 Bash 命令）仍保持原有行为。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const PATTERN = /!\{([^}]+)\}/g;
	const TIMEOUT_MS = 30000;

	pi.on("input", async (event, ctx) => {
		const text = event.text;

		// 如果输入是整行 Bash 命令（以 ! 开头），则不处理。
		// 这样可以保留原有的 !command 行为。
		if (text.trimStart().startsWith("!") && !text.trimStart().startsWith("!{")) {
			return { action: "continue" };
		}

		// 检查是否包含行内 Bash 模式。
		if (!PATTERN.test(text)) {
			return { action: "continue" };
		}

		// test() 调用后重置正则表达式状态。
		PATTERN.lastIndex = 0;

		let result = text;
		const expansions: Array<{ command: string; output: string; error?: string }> = [];

		// 先找出所有匹配项，避免遍历时替换造成问题。
		const matches: Array<{ full: string; command: string }> = [];
		let match = PATTERN.exec(text);
		while (match) {
			matches.push({ full: match[0], command: match[1] });
			match = PATTERN.exec(text);
		}

		// 执行每条命令并收集结果。
		for (const { full, command } of matches) {
			try {
				const bashResult = await pi.exec("bash", ["-c", command], {
					timeout: TIMEOUT_MS,
				});

				const output = bashResult.stdout || bashResult.stderr || "";
				const trimmed = output.trim();

				if (bashResult.code !== 0 && bashResult.stderr) {
					expansions.push({
						command,
						output: trimmed,
						error: `exit code ${bashResult.code}`,
					});
				} else {
					expansions.push({ command, output: trimmed });
				}

				result = result.replace(full, trimmed);
			} catch (err) {
				const errorMsg = err instanceof Error ? err.message : String(err);
				expansions.push({ command, output: "", error: errorMsg });
				result = result.replace(full, `[error: ${errorMsg}]`);
			}
		}

		// 如果界面可用，显示展开后的内容。
		if (ctx.hasUI && expansions.length > 0) {
			const summary = expansions
				.map((e) => {
					const status = e.error ? ` (${e.error})` : "";
					const preview = e.output.length > 50 ? `${e.output.slice(0, 50)}...` : e.output;
					return `!{${e.command}}${status} -> "${preview}"`;
				})
				.join("\n");

			ctx.ui.notify(`Expanded ${expansions.length} inline command(s):\n${summary}`, "info");
		}

		return { action: "transform", text: result, images: event.images };
	});
}
