/**
 * Claude 规则扩展。
 *
 * 扫描项目的 .claude/rules/ 目录，查找规则文件并将其列入系统提示词。
 * 随后，智能体可以使用 read 工具加载
 * 在需要时应用特定规则。
 *
 * .claude/rules/ 的使用建议：
 * - 规则主题应明确：每个文件聚焦一个主题（例如 testing.md、api-design.md）
 * - 文件名应具有描述性：通过文件名即可了解规则涵盖的内容
 * - 谨慎使用条件规则：仅在规则确实适用于特定文件类型时添加 paths 前置元数据
 * - 使用子目录整理文件：将相关规则归类（例如 frontend/、backend/）
 *
 * 用法：
 * 1. 将此文件复制到 ~/.pi/agent/extensions/ 或项目的 .pi/extensions/ 目录
 * 2. 在项目根目录创建 .claude/rules/ 文件夹
 * 3. 在其中添加包含规则的 .md 文件
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * 递归查找目录中的所有 .md 文件。
 */
function findMarkdownFiles(dir: string, basePath: string = ""): string[] {
	const results: string[] = [];

	if (!fs.existsSync(dir)) {
		return results;
	}

	const entries = fs.readdirSync(dir, { withFileTypes: true });

	for (const entry of entries) {
		const relativePath = basePath ? `${basePath}/${entry.name}` : entry.name;

		if (entry.isDirectory()) {
			results.push(...findMarkdownFiles(path.join(dir, entry.name), relativePath));
		} else if (entry.isFile() && entry.name.endsWith(".md")) {
			results.push(relativePath);
		}
	}

	return results;
}

export default function claudeRulesExtension(pi: ExtensionAPI) {
	let ruleFiles: string[] = [];
	let rulesDir: string = "";

	// 会话开始时扫描规则文件。
	pi.on("session_start", async (_event, ctx) => {
		rulesDir = path.join(ctx.cwd, ".claude", "rules");
		ruleFiles = findMarkdownFiles(rulesDir);

		if (ruleFiles.length > 0) {
			ctx.ui.notify(`Found ${ruleFiles.length} rule(s) in .claude/rules/`, "info");
		}
	});

	// 将可用规则追加到系统提示词。
	pi.on("before_agent_start", async (event) => {
		if (ruleFiles.length === 0) {
			return;
		}

		const rulesList = ruleFiles.map((f) => `- .claude/rules/${f}`).join("\n");

		return {
			systemPrompt:
				event.systemPrompt +
				`

## Project Rules

The following project rules are available in .claude/rules/:

${rulesList}

When working on tasks related to these rules, use the read tool to load the relevant rule files for guidance.
`,
		};
	});
}
