/**
 * 提示词定制扩展。
 *
 * 演示如何使用 systemPromptOptions 添加与上下文相关的提示词区段，
 * 而无需替换或重新解析完整的渲染后提示词。
 *
 * 用法：
 * 1. 将此文件复制到 ~/.pi/agent/extensions/ 或项目的 .pi/extensions/ 目录
 * 2. 加载扩展后，它会根据当前启用的工具和技能自动调整
 */

import type { BuildSystemPromptOptions, ExtensionAPI } from "@earendil-works/pi-coding-agent";

function buildToolGuidance(options: BuildSystemPromptOptions): string {
	const hasTool = (name: string) => options.selectedTools?.includes(name) ?? false;
	const rules: string[] = [];

	if (hasTool("read")) {
		rules.push(
			"- Use `read` for file contents; it supports text and images.",
			"- For large files, use `offset` and `limit` to read in chunks.",
		);
	}
	if (hasTool("bash")) {
		rules.push("- Use `bash` for file operations such as `ls`, `find`, and `grep`.");
	}
	if (hasTool("edit")) {
		rules.push("- Use `edit` for precise text replacements that match existing content exactly.");
	}
	if (hasTool("write")) {
		rules.push("- Use `write` to create new files or replace existing files completely.");
	}
	if (options.skills && options.skills.length > 0) {
		rules.push(`- Available skills: ${options.skills.map((skill) => skill.name).join(", ")}.`);
	}

	return rules.join("\n");
}

export default function promptCustomizer(pi: ExtensionAPI) {
	pi.on("before_agent_start", (event) => {
		const guidance = buildToolGuidance(event.systemPromptOptions);
		if (guidance) {
			event.systemPromptOptions.sections.tool_guidance = guidance;
		} else {
			delete event.systemPromptOptions.sections.tool_guidance;
		}
	});
}
