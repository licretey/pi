import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

describe("export HTML skill block rendering", () => {
	const templateJs = readFileSync(new URL("../src/core/export-html/template.js", import.meta.url), "utf-8");

	it("strips skill wrapper XML from user message rendering", () => {
		// Skill 命令会在原始用户消息中保存结构化包装：
		//   <skill name="..." location="...">\n...\n</skill>\n\nactual prompt
		// 导出渲染器必须识别该包装结构，并且只渲染用户可见的提示，
		// 而不是 Pi 生成的 <skill>...</skill> XML 标签。
		expect(templateJs).toMatch(/parseSkillBlock/);
		expect(templateJs).toMatch(/skillBlock\.userMessage/);
	});

	it("renders skill invocation and user message as separate sibling blocks", () => {
		// 技能块和用户消息应分别渲染为条目级元素，
		// 这与 TUI 布局一致：SkillInvocationMessageComponent 和
		// UserMessageComponent 是同级组件，而非嵌套关系。
		expect(templateJs).toMatch(/skill-invocation/);

		// 技能块包含 userMessage 时，必须生成对应的用户消息 div。
		// 作为独立区块放在 skill-invocation div 后面，其中包含用户编写的文本。
		// 验证代码会检查 hasUserContent，只有在
		// 即使技能区块没有用户提示词和图片，也应如此。
		expect(templateJs).toMatch(/hasUserContent/);
	});

	it("renders skill content as markdown, not raw text", () => {
		// 技能块正文是 Markdown（来自 SKILL.md 文件）。
		// 应通过 safeMarkedParse 渲染，而不是作为原始文本转义。
		expect(templateJs).toMatch(/safeMarkedParse\(skillBlock\.content\)/);
	});

	it("shows skill name and user message in the sidebar tree", () => {
		// 侧边栏树形视图应同时显示技能名称和用户提示，
		// 两者都要保留，而不能只保留其中之一。
		expect(templateJs).toMatch(/tree-role-skill/);
	});
});
