import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

describe("export HTML markdown link sanitization", () => {
	const templateJs = readFileSync(new URL("../src/core/export-html/template.js", import.meta.url), "utf-8");

	it("overrides the marked link renderer to use scheme allow-list sanitization", () => {
		expect(templateJs).toMatch(/link\s*\(\s*token\s*\)/);
		expect(templateJs).toMatch(/sanitizeMarkdownUrl\(token\.href\)/);
		expect(templateJs).toMatch(/\^\(https\?\|mailto\|tel\|ftp\)/);
	});

	it("overrides the marked image renderer to use scheme allow-list sanitization", () => {
		expect(templateJs).toMatch(/image\s*\(\s*token\s*\)/);
		expect(templateJs).toMatch(/sanitizeMarkdownUrl\(token\.href\)/);
	});

	it("strips C0 controls before checking and emitting markdown URLs", () => {
		expect(templateJs).toContain("replace(/[\\x00-\\x1f\\x7f]/g, '')");
		expect(templateJs).not.toMatch(/\^\\s\*\(javascript\|vbscript\|data\):/i);
	});

	it("escapes href attributes in the custom link renderer", () => {
		// 链接渲染器必须转义 href 值，以防止突破 HTML 属性边界。
		expect(templateJs).toMatch(/escapeHtml\(href\)/);
	});

	it("escapes image mimeType attributes", () => {
		// 必须转义图像的 mimeType，以防止突破 HTML 属性边界。
		expect(templateJs).not.toMatch(/\$\{img\.mimeType\}/);
		expect(templateJs).toMatch(/escapeHtml\(img\.mimeType/);
	});

	it("escapes image data attributes", () => {
		// 图像数据会嵌入 src 属性，因此不得允许突破属性边界。
		expect(templateJs).not.toMatch(/;base64,\$\{img\.data\}"/);
		expect(templateJs).toMatch(/;base64,\$\{escapeHtml\(img\.data \|\| (?:''|"")\)\}"/);
	});

	it("escapes entry IDs before inserting them into attributes", () => {
		// 会话条目 ID 会嵌入 id 和 data-entry-id 属性。
		expect(templateJs).not.toMatch(/id="\$\{entryId\}"/);
		expect(templateJs).not.toMatch(/data-entry-id="\$\{entryId\}"/);
		expect(templateJs).toMatch(/entry-\$\{escapeHtml\(entry\.id\)\}/);
		expect(templateJs).toMatch(/data-entry-id="\$\{escapeHtml\(entryId\)\}"/);
	});

	it("escapes tree metadata rendered from session fields", () => {
		// 树形视图通过 innerHTML 渲染会话元数据，因此必须转义动态字段。
		expect(templateJs).not.toMatch(/\[\$\{msg\.toolName \|\| 'tool'\}\]/);
		expect(templateJs).not.toMatch(/\[\$\{msg\.role\}\]/);
		expect(templateJs).not.toMatch(/\[model: \$\{entry\.modelId\}\]/);
		expect(templateJs).not.toMatch(/\[thinking: \$\{entry\.thinkingLevel\}\]/);
		expect(templateJs).not.toMatch(/\[\$\{entry\.type\}\]/);
		expect(templateJs).toMatch(/\$\{escapeHtml\(msg\.toolName \|\| 'tool'\)\}/);
		expect(templateJs).toMatch(/\$\{escapeHtml\(msg\.role\)\}/);
		expect(templateJs).toMatch(/\$\{escapeHtml\(entry\.modelId\)\}/);
		expect(templateJs).toMatch(/\$\{escapeHtml\(entry\.thinkingLevel\)\}/);
		expect(templateJs).toMatch(/\$\{escapeHtml\(entry\.type\)\}/);
	});

	it("escapes model names in the exported header", () => {
		// 助手消息的 provider/model 值从会话中收集，并通过 innerHTML 渲染。
		expect(templateJs).not.toMatch(/\$\{globalStats\.models\.join\(', '\) \|\| 'unknown'\}/);
		expect(templateJs).toMatch(/\$\{escapeHtml\(globalStats\.models\.join\(', '\) \|\| 'unknown'\)\}/);
	});
});
