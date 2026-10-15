import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";

/**
 * 测试修复外部文件中的数组更改被覆盖的问题。
 *
 * 问题场景如下：
 * 1. Pi 启动时，settings.json 中的 packages 为 ["npm:some-pkg"]。
 * 2. 用户在外部将文件中的 packages 改为空数组。
 * 3. 用户通过界面更改一项无关设置（例如主题）。
 * 4. save() 使用过期的内存状态，将 packages 恢复为 ["npm:some-pkg"]。
 *
 * 修复方案会跟踪会话期间明确修改过的字段，并且只在保存时用这些字段覆盖文件中的值。
 */
describe("SettingsManager - External Edit Preservation", () => {
	const testDir = join(process.cwd(), "test-settings-bug-tmp");
	const agentDir = join(testDir, "agent");
	const projectDir = join(testDir, "project");

	beforeEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
	});

	it("should preserve file changes to packages array when changing unrelated setting", async () => {
		const settingsPath = join(agentDir, "settings.json");

		// 初始状态：packages 中有一个条目。
		writeFileSync(
			settingsPath,
			JSON.stringify({
				theme: "dark",
				packages: ["npm:pi-mcp-adapter"],
			}),
		);

		// Pi 启动并将设置加载到内存中。
		const manager = SettingsManager.create(projectDir, agentDir);

		// 此时 globalSettings.packages = ["npm:pi-mcp-adapter"]。
		expect(manager.getPackages()).toEqual(["npm:pi-mcp-adapter"]);

		// 用户在外部编辑 settings.json，移除该包。
		const currentSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
		currentSettings.packages = []; // 用户希望移除此项！
		writeFileSync(settingsPath, JSON.stringify(currentSettings, null, 2));

		// 验证文件已更改。
		expect(JSON.parse(readFileSync(settingsPath, "utf-8")).packages).toEqual([]);

		// 用户通过界面更改一项无关设置（这会触发保存）。
		manager.setTheme("light");
		await manager.flush();

		// 修复后应保留空的 packages（不能恢复为启动时的值）。
		const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));

		expect(savedSettings.packages).toEqual([]);
		expect(savedSettings.theme).toBe("light");
	});

	it("should preserve file changes to extensions array when changing unrelated setting", async () => {
		const settingsPath = join(agentDir, "settings.json");

		writeFileSync(
			settingsPath,
			JSON.stringify({
				theme: "dark",
				extensions: ["/old/extension.ts"],
			}),
		);

		const manager = SettingsManager.create(projectDir, agentDir);

		// 用户在外部更新 extensions。
		const currentSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
		currentSettings.extensions = ["/new/extension.ts"];
		writeFileSync(settingsPath, JSON.stringify(currentSettings, null, 2));

		// 更改一项无关设置。
		manager.setDefaultThinkingLevel("high");
		await manager.flush();

		const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));

		// 修复后应保留 extensions（不能恢复为启动时的值）。
		expect(savedSettings.extensions).toEqual(["/new/extension.ts"]);
	});

	it("should preserve external project settings changes when updating unrelated project field", async () => {
		const projectSettingsPath = join(projectDir, ".pi", "settings.json");
		writeFileSync(
			projectSettingsPath,
			JSON.stringify({
				extensions: ["./old-extension.ts"],
				prompts: ["./old-prompt.md"],
			}),
		);

		const manager = SettingsManager.create(projectDir, agentDir);

		const currentProjectSettings = JSON.parse(readFileSync(projectSettingsPath, "utf-8"));
		currentProjectSettings.prompts = ["./new-prompt.md"];
		writeFileSync(projectSettingsPath, JSON.stringify(currentProjectSettings, null, 2));

		manager.setProjectExtensionPaths(["./updated-extension.ts"]);
		await manager.flush();

		const savedProjectSettings = JSON.parse(readFileSync(projectSettingsPath, "utf-8"));
		expect(savedProjectSettings.prompts).toEqual(["./new-prompt.md"]);
		expect(savedProjectSettings.extensions).toEqual(["./updated-extension.ts"]);
	});

	it("should let in-memory project changes override external changes for the same project field", async () => {
		const projectSettingsPath = join(projectDir, ".pi", "settings.json");
		writeFileSync(
			projectSettingsPath,
			JSON.stringify({
				extensions: ["./initial-extension.ts"],
			}),
		);

		const manager = SettingsManager.create(projectDir, agentDir);

		const currentProjectSettings = JSON.parse(readFileSync(projectSettingsPath, "utf-8"));
		currentProjectSettings.extensions = ["./external-extension.ts"];
		writeFileSync(projectSettingsPath, JSON.stringify(currentProjectSettings, null, 2));

		manager.setProjectExtensionPaths(["./in-memory-extension.ts"]);
		await manager.flush();

		const savedProjectSettings = JSON.parse(readFileSync(projectSettingsPath, "utf-8"));
		expect(savedProjectSettings.extensions).toEqual(["./in-memory-extension.ts"]);
	});
});
