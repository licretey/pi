import { defineExtension, type PromptInput, section } from "@earendil-works/pi-durable";
import { getAgentDir } from "../../config.ts";
import { loadProjectContextFiles } from "../../core/resource-loader.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import { loadSkills, type Skill } from "../../core/skills.ts";
import { buildSystemPromptSections } from "../../core/system-prompt.ts";
import { bashToolSystemPromptContribution } from "../../core/tools/bash.ts";
import { editToolSystemPromptContribution } from "../../core/tools/edit.ts";
import { readToolSystemPromptContribution } from "../../core/tools/read.ts";
import { writeToolSystemPromptContribution } from "../../core/tools/write.ts";

const CONTRIBUTIONS = {
	read: readToolSystemPromptContribution,
	bash: bashToolSystemPromptContribution,
	edit: editToolSystemPromptContribution,
	write: writeToolSystemPromptContribution,
};

/** pi 的提示词分节顺序；`buildSystemPromptSections()` 会省略没有内容的分节。 */
const KEYS = ["preamble", "tools", "rules", "docs", "project_context", "skills", "cwd"] as const;

/**
 * 将 pi 的系统提示词作为一个扩展：包含针对请求所用工具以及会话目录生成的 `buildSystemPromptSections()` 分节。
 * 上下文文件和技能按目录加载一次，与 pi 启动时的行为一致。
 */
export function createPiPrompt(settings: SettingsManager, fallbackCwd: string) {
	const resources = new Map<string, { contextFiles: { path: string; content: string }[]; skills: Skill[] }>();
	const load = (cwd: string) => {
		let found = resources.get(cwd);
		if (found === undefined) {
			const agentDir = getAgentDir();
			found = {
				contextFiles: loadProjectContextFiles({ cwd, agentDir }),
				skills: loadSkills({ cwd, agentDir, skillPaths: settings.getSkillPaths(), includeDefaults: true }).skills,
			};
			resources.set(cwd, found);
		}
		return found;
	};
	// 同一个请求的各分节由同一次构建生成。
	const built = new WeakMap<PromptInput, Record<string, string>>();
	const build = (input: PromptInput): Record<string, string> => {
		let sections = built.get(input);
		if (sections === undefined) {
			sections = buildSections(input);
			built.set(input, sections);
		}
		return sections;
	};
	const buildSections = (input: PromptInput): Record<string, string> => {
		const cwd = input.env?.cwd ?? input.agent.cwd ?? fallbackCwd;
		const selectedTools = input.agent.tools.map((tool) => tool.name);
		const snippets: Record<string, string> = {};
		const guidelines: Record<string, string[]> = {};
		for (const name of selectedTools) {
			const contribution = CONTRIBUTIONS[name as keyof typeof CONTRIBUTIONS];
			if (contribution === undefined) continue;
			snippets[name] = contribution.snippet;
			guidelines[name] = [...contribution.guidelines];
		}
		return buildSystemPromptSections({
			cwd,
			selectedTools,
			toolSnippets: snippets,
			toolGuidelines: guidelines,
			...load(cwd),
		});
	};
	return defineExtension({
		name: "pi-prompt",
		// 构建后的分节各自带有标签。
		sections: KEYS.map((key) => section(key, (input) => build(input)[key], { tag: false })),
	});
}
