import { stripVTControlCharacters } from "node:util";
import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type {
	ModelChangeEntry,
	SessionEntry,
	SessionMessageEntry,
	SessionTreeNode,
} from "../src/core/session-manager.ts";
import { TreeSelectorComponent } from "../src/modes/interactive/components/tree-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

beforeAll(() => {
	initTheme("dark");
});

beforeEach(() => {
	// 确保测试相互隔离：按键绑定是全局单例。
	setKeybindings(new KeybindingsManager());
});

// 创建用户消息条目的辅助函数。
function userMessage(id: string, parentId: string | null, content: string): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message: { role: "user", content, timestamp: Date.now() },
	};
}

// 创建助手消息条目的辅助函数。
function assistantMessage(id: string, parentId: string | null, text: string): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		},
	};
}

// 创建仅含工具调用的助手消息（默认模式下会被筛除）。
function toolCallOnlyAssistant(id: string, parentId: string | null): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: `tc-${id}`, name: "read", arguments: { path: "test.ts" } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		},
	};
}

// 创建 model_change 条目的辅助函数。
function modelChange(id: string, parentId: string | null): ModelChangeEntry {
	return {
		type: "model_change",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		provider: "anthropic",
		modelId: "claude-sonnet-4",
	};
}

// 根据条目的 parentId 关系构造树。
function buildTree(entries: Array<SessionEntry>): SessionTreeNode[] {
	if (entries.length === 0) return [];

	const nodes: SessionTreeNode[] = entries.map((entry) => ({
		entry,
		children: [],
	}));

	const byId = new Map<string, SessionTreeNode>();
	for (const node of nodes) {
		byId.set(node.entry.id, node);
	}

	const roots: SessionTreeNode[] = [];
	for (const node of nodes) {
		if (node.entry.parentId === null) {
			roots.push(node);
		} else {
			const parent = byId.get(node.entry.parentId);
			if (parent) {
				parent.children.push(node);
			}
		}
	}
	return roots;
}

describe("TreeSelectorComponent", () => {
	describe("initial selection with metadata entries", () => {
		test("focuses nearest visible ancestor when currentLeafId is a model_change with sibling branch", () => {
			// 树结构：
			// user-1
			// └── asst-1
			//     ├── user-2 (active branch)
			//     │   └── model-1 (model_change, CURRENT LEAF)
			//     └── user-3 (sibling branch, added later chronologically)
			const entries = [
				userMessage("user-1", null, "hello"),
				assistantMessage("asst-1", "user-1", "hi"),
				userMessage("user-2", "asst-1", "active branch"), // 当前活动分支。
				modelChange("model-1", "user-2"), // 当前叶节点（元数据）。
				userMessage("user-3", "asst-1", "sibling branch"), // 兄弟分支。
			];
			const tree = buildTree(entries);

			const selector = new TreeSelectorComponent(
				tree,
				"model-1", // currentLeafId 指向 model_change 条目。
				24,
				() => {},
				() => {},
			);

			const list = selector.getTreeList();
			// 应聚焦于 model-1 的父级 user-2，而不是最后一项 user-3。
			expect(list.getSelectedNode()?.entry.id).toBe("user-2");
		});

		test("hides context edits by default and labels them in all mode", () => {
			const entries: SessionEntry[] = [
				userMessage("user-1", null, "hello"),
				assistantMessage("asst-1", "user-1", "hi"),
				{
					type: "context_edit",
					id: "edit-1",
					parentId: "asst-1",
					timestamp: new Date().toISOString(),
					targetId: "asst-1",
					replacement: null,
				},
			];
			const tree = buildTree(entries);
			const defaultSelector = new TreeSelectorComponent(
				tree,
				"edit-1",
				24,
				() => {},
				() => {},
			);
			expect(defaultSelector.getTreeList().getSelectedNode()?.entry.id).toBe("asst-1");

			const allSelector = new TreeSelectorComponent(
				tree,
				"edit-1",
				24,
				() => {},
				() => {},
				undefined,
				undefined,
				"all",
			);
			const rendered = allSelector.getTreeList().render(200).map(stripVTControlCharacters).join("\n");
			expect(rendered).toContain("[context omit: asst-1]");
		});

		test("focuses nearest visible ancestor when currentLeafId is a thinking_level_change entry", () => {
			// 结构相同，但使用 thinking_level_change 替代 model_change。
			const entries = [
				userMessage("user-1", null, "hello"),
				assistantMessage("asst-1", "user-1", "hi"),
				userMessage("user-2", "asst-1", "active branch"),
				{
					type: "thinking_level_change" as const,
					id: "thinking-1",
					parentId: "user-2",
					timestamp: new Date().toISOString(),
					thinkingLevel: "high",
				},
				userMessage("user-3", "asst-1", "sibling branch"),
			];
			const tree = buildTree(entries);

			const selector = new TreeSelectorComponent(
				tree,
				"thinking-1",
				24,
				() => {},
				() => {},
			);

			const list = selector.getTreeList();
			expect(list.getSelectedNode()?.entry.id).toBe("user-2");
		});
	});

	describe("filter switching with parent traversal", () => {
		test("switches to nearest visible user message when changing to user-only filter", () => {
			// 仅显示用户消息时，列表为 [user-1, user-2, user-3]。
			const entries = [
				userMessage("user-1", null, "hello"),
				assistantMessage("asst-1", "user-1", "hi"),
				userMessage("user-2", "asst-1", "active branch"),
				assistantMessage("asst-2", "user-2", "response"),
				userMessage("user-3", "asst-1", "sibling branch"),
			];
			const tree = buildTree(entries);

			const selector = new TreeSelectorComponent(
				tree,
				"asst-2",
				24,
				() => {},
				() => {},
			);

			const list = selector.getTreeList();
			expect(list.getSelectedNode()?.entry.id).toBe("asst-2");

			// 模拟按下 Ctrl+U（仅显示用户消息）。
			selector.handleInput("\x15");

			// 此时应选中 user-2（父级用户消息），而不是 user-3。
			expect(list.getSelectedNode()?.entry.id).toBe("user-2");
		});

		test("returns to nearest visible ancestor when switching back to default filter", () => {
			// 相同的分支结构。
			const entries = [
				userMessage("user-1", null, "hello"),
				assistantMessage("asst-1", "user-1", "hi"),
				userMessage("user-2", "asst-1", "active branch"),
				assistantMessage("asst-2", "user-2", "response"),
				userMessage("user-3", "asst-1", "sibling branch"),
			];
			const tree = buildTree(entries);

			const selector = new TreeSelectorComponent(
				tree,
				"asst-2",
				24,
				() => {},
				() => {},
			);

			const list = selector.getTreeList();
			expect(list.getSelectedNode()?.entry.id).toBe("asst-2");

			// 切换为仅显示用户消息。
			selector.handleInput("\x15"); // Ctrl+U
			expect(list.getSelectedNode()?.entry.id).toBe("user-2");

			// 切回默认筛选后仍应选中 user-2，
			// 因为这是沿父级遍历导航到的条目。
			selector.handleInput("\x04"); // Ctrl+D
			expect(list.getSelectedNode()?.entry.id).toBe("user-2");
		});
	});

	describe("help", () => {
		test("renders semantic help rows without truncating narrow terminal controls", () => {
			const entries = [userMessage("user-1", null, "hello"), assistantMessage("asst-1", "user-1", "hi")];
			const tree = buildTree(entries);
			const selector = new TreeSelectorComponent(
				tree,
				"asst-1",
				24,
				() => {},
				() => {},
			);

			const plainLines = selector.render(30).map(stripVTControlCharacters);
			const plain = plainLines.join("\n");
			expect(plain).toContain("branch");
			expect(plain).toContain("copy");
			expect(plain).toContain("filters");
			expect(plain).toContain("cycle");
			expect(plain).toContain("label time");
			expect(plain).not.toContain("...");
			expect(plainLines.every((line) => visibleWidth(line) <= 30)).toBe(true);
		});
	});

	describe("copy", () => {
		test("copies the full selected message with ctrl+x", () => {
			const message = `${"long message ".repeat(30)}\nsecond line`;
			const tree = buildTree([userMessage("user-1", null, "hello"), assistantMessage("asst-1", "user-1", message)]);
			const selector = new TreeSelectorComponent(
				tree,
				"asst-1",
				24,
				() => {},
				() => {},
			);
			let copied: string | undefined;
			selector.onCopy = (text) => {
				copied = text;
			};

			selector.handleInput("\x18");

			expect(copied).toBe(message);
		});
	});

	describe("label timestamps", () => {
		test("toggles label timestamps for labeled nodes", () => {
			const entries = [userMessage("user-1", null, "hello"), assistantMessage("asst-1", "user-1", "hi")];
			const tree = buildTree(entries);
			const labelDate = new Date(2026, 2, 28, 14, 32, 0);
			tree[0]!.label = "checkpoint";
			tree[0]!.labelTimestamp = labelDate.toISOString();

			const selector = new TreeSelectorComponent(
				tree,
				"asst-1",
				24,
				() => {},
				() => {},
			);

			const list = selector.getTreeList();
			let render = list.render(200).join("\n");
			expect(render).toContain("[checkpoint]");
			expect(render).not.toContain("3/28 14:32");
			expect(render).not.toContain("[+label time]");

			selector.handleInput("T");

			render = list.render(200).join("\n");
			expect(render).toContain("3/28 14:32");
			expect(render).toContain("[+label time]");
		});
	});

	describe("empty filter preservation", () => {
		test("preserves selection when switching to empty labeled filter and back", () => {
			// 不含标签的树。
			const entries = [
				userMessage("user-1", null, "hello"),
				assistantMessage("asst-1", "user-1", "hi"),
				userMessage("user-2", "asst-1", "bye"),
				assistantMessage("asst-2", "user-2", "goodbye"),
			];
			const tree = buildTree(entries);

			const selector = new TreeSelectorComponent(
				tree,
				"asst-2",
				24,
				() => {},
				() => {},
			);

			const list = selector.getTreeList();
			expect(list.getSelectedNode()?.entry.id).toBe("asst-2");

			// 切换为仅显示带标签的条目（没有标签，因此结果为空）。
			selector.handleInput("\x0c"); // Ctrl+L

			// 列表应为空，getSelectedNode 返回 undefined。
			expect(list.getSelectedNode()).toBeUndefined();

			// 切回默认筛选。
			selector.handleInput("\x04"); // Ctrl+D

			// 应恢复选中 asst-2（切换到空筛选前的选中项）。
			expect(list.getSelectedNode()?.entry.id).toBe("asst-2");
		});

		test("preserves selection through multiple empty filter switches", () => {
			const entries = [userMessage("user-1", null, "hello"), assistantMessage("asst-1", "user-1", "hi")];
			const tree = buildTree(entries);

			const selector = new TreeSelectorComponent(
				tree,
				"asst-1",
				24,
				() => {},
				() => {},
			);

			const list = selector.getTreeList();
			expect(list.getSelectedNode()?.entry.id).toBe("asst-1");

			// 切换为仅显示带标签的条目（结果为空）；Ctrl+L 可在带标签筛选和默认筛选间切换。
			selector.handleInput("\x0c"); // Ctrl+L：仅显示带标签的条目。
			expect(list.getSelectedNode()).toBeUndefined();

			// 切回默认筛选，再次切换到仅显示带标签的条目。
			selector.handleInput("\x0c"); // Ctrl+L：切回默认模式。
			expect(list.getSelectedNode()?.entry.id).toBe("asst-1");

			selector.handleInput("\x0c"); // 再次按 Ctrl+L：仍仅显示带标签的条目。
			expect(list.getSelectedNode()).toBeUndefined();

			// 使用 Ctrl+D 切回默认筛选。
			selector.handleInput("\x04"); // Ctrl+D
			expect(list.getSelectedNode()?.entry.id).toBe("asst-1");
		});
	});

	describe("branch navigation and folding with ctrl+arrow keys", () => {
		// 按键转义序列。
		const UP = "\x1b[A";
		const DOWN = "\x1b[B";
		const CTRL_LEFT = "\x1b[1;5D";
		const CTRL_RIGHT = "\x1b[1;5C";
		const ALT_LEFT = "\x1b[1;3D";
		const ALT_RIGHT = "\x1b[1;3C";

		// 树结构：
		//
		// user-1
		// asst-1
		// user-2
		// asst-2          ← 分支点（有两个子节点）
		// ├─ user-3a      ← 分支 A（当前分支：叶节点为 asst-4a）
		// │  asst-3a
		// │  user-4a
		// │  asst-4a
		// └─ user-3b      ← 分支 B
		//    asst-3b
		//    user-4b
		//
		// 可折叠节点：user-1（根节点）、user-3a（片段起点）、user-3b（片段起点）。

		function buildBranchingTree() {
			const entries: SessionEntry[] = [
				userMessage("user-1", null, "first message"),
				assistantMessage("asst-1", "user-1", "response 1"),
				userMessage("user-2", "asst-1", "second message"),
				assistantMessage("asst-2", "user-2", "response 2"),
				// 分支 A（活动分支）。
				userMessage("user-3a", "asst-2", "branch A start"),
				assistantMessage("asst-3a", "user-3a", "branch A response"),
				userMessage("user-4a", "asst-3a", "branch A deep"),
				assistantMessage("asst-4a", "user-4a", "branch A leaf"),
				// 分支 B。
				userMessage("user-3b", "asst-2", "branch B start"),
				assistantMessage("asst-3b", "user-3b", "branch B response"),
				userMessage("user-4b", "asst-3b", "branch B deep"),
			];
			return buildTree(entries);
		}

		test("ctrl+right unfolds a folded node, then does segment jump when unfolded", () => {
			const tree = buildBranchingTree();
			const selector = new TreeSelectorComponent(
				tree,
				"asst-4a",
				24,
				() => {},
				() => {},
			);
			const list = selector.getTreeList();

			selector.handleInput(CTRL_LEFT); // asst-4a → user-3a
			expect(list.getSelectedNode()?.entry.id).toBe("user-3a");

			selector.handleInput(CTRL_LEFT); // fold user-3a
			expect(list.getSelectedNode()?.entry.id).toBe("user-3a");

			selector.handleInput(DOWN); // user-3a → user-3b (children hidden)
			expect(list.getSelectedNode()?.entry.id).toBe("user-3b");

			selector.handleInput(UP); // user-3b → user-3a
			expect(list.getSelectedNode()?.entry.id).toBe("user-3a");

			selector.handleInput(CTRL_RIGHT); // unfold user-3a
			expect(list.getSelectedNode()?.entry.id).toBe("user-3a");

			selector.handleInput(DOWN); // user-3a → asst-3a (children restored)
			expect(list.getSelectedNode()?.entry.id).toBe("asst-3a");

			selector.handleInput(CTRL_LEFT); // asst-3a → user-3a
			expect(list.getSelectedNode()?.entry.id).toBe("user-3a");

			selector.handleInput(CTRL_RIGHT); // user-3a → asst-4a（跨段跳转到叶节点）。
			expect(list.getSelectedNode()?.entry.id).toBe("asst-4a");
		});

		test("alt+left/right are aliases for fold and unfold navigation", () => {
			const tree = buildBranchingTree();
			const selector = new TreeSelectorComponent(
				tree,
				"asst-4a",
				24,
				() => {},
				() => {},
			);
			const list = selector.getTreeList();

			selector.handleInput(ALT_LEFT); // asst-4a → user-3a
			expect(list.getSelectedNode()?.entry.id).toBe("user-3a");

			selector.handleInput(ALT_LEFT); // fold user-3a
			expect(list.getSelectedNode()?.entry.id).toBe("user-3a");

			selector.handleInput(ALT_RIGHT); // unfold user-3a
			expect(list.getSelectedNode()?.entry.id).toBe("user-3a");

			selector.handleInput(ALT_RIGHT); // user-3a → asst-4a
			expect(list.getSelectedNode()?.entry.id).toBe("asst-4a");
		});

		test("folding root hides entire subtree, nested fold preserved on unfold", () => {
			const tree = buildBranchingTree();
			const selector = new TreeSelectorComponent(
				tree,
				"asst-4a",
				24,
				() => {},
				() => {},
			);
			const list = selector.getTreeList();

			selector.handleInput(CTRL_LEFT); // asst-4a → user-3a
			expect(list.getSelectedNode()?.entry.id).toBe("user-3a");

			selector.handleInput(CTRL_LEFT); // fold user-3a
			expect(list.getSelectedNode()?.entry.id).toBe("user-3a");

			selector.handleInput(CTRL_LEFT); // user-3a (folded) → user-1
			expect(list.getSelectedNode()?.entry.id).toBe("user-1");

			selector.handleInput(CTRL_LEFT); // fold user-1
			expect(list.getSelectedNode()?.entry.id).toBe("user-1");

			selector.handleInput(DOWN); // 仅有一个可见节点，因此循环回到该节点。
			expect(list.getSelectedNode()?.entry.id).toBe("user-1");

			selector.handleInput(CTRL_RIGHT); // unfold user-1
			expect(list.getSelectedNode()?.entry.id).toBe("user-1");

			selector.handleInput(CTRL_RIGHT); // user-1 → user-3a（跨段跳转；user-3a 仍处于折叠状态）。
			expect(list.getSelectedNode()?.entry.id).toBe("user-3a");

			selector.handleInput(DOWN); // user-3a → user-3b（user-3a 仍处于折叠状态）。
			expect(list.getSelectedNode()?.entry.id).toBe("user-3b");
		});

		test("fold and navigate on non-active branch", () => {
			const tree = buildBranchingTree();
			const selector = new TreeSelectorComponent(
				tree,
				"asst-4a",
				24,
				() => {},
				() => {},
			);
			const list = selector.getTreeList();

			// 向下导航到 user-3b（分支 B）。
			let found = false;
			for (let i = 0; i < 20; i++) {
				selector.handleInput(DOWN);
				if (list.getSelectedNode()?.entry.id === "user-3b") {
					found = true;
					break;
				}
			}
			expect(found).toBe(true);

			selector.handleInput(CTRL_RIGHT); // user-3b → user-4b（跨段跳转到叶节点）。
			expect(list.getSelectedNode()?.entry.id).toBe("user-4b");

			selector.handleInput(CTRL_LEFT); // user-4b → user-3b
			expect(list.getSelectedNode()?.entry.id).toBe("user-3b");

			selector.handleInput(CTRL_LEFT); // fold user-3b
			expect(list.getSelectedNode()?.entry.id).toBe("user-3b");

			selector.handleInput(CTRL_LEFT); // user-3b (folded) → user-1
			expect(list.getSelectedNode()?.entry.id).toBe("user-1");
		});

		test("fold and navigate with multiple roots", () => {
			const entries: SessionEntry[] = [
				userMessage("user-1", null, "first root"),
				assistantMessage("asst-1", "user-1", "response 1"),
				userMessage("user-2", null, "second root"),
				assistantMessage("asst-2", "user-2", "response 2"),
			];
			const tree = buildTree(entries);
			const selector = new TreeSelectorComponent(
				tree,
				"asst-1",
				24,
				() => {},
				() => {},
			);
			const list = selector.getTreeList();

			expect(list.getSelectedNode()?.entry.id).toBe("asst-1");

			selector.handleInput(CTRL_LEFT); // asst-1 → user-1
			expect(list.getSelectedNode()?.entry.id).toBe("user-1");

			selector.handleInput(CTRL_LEFT); // fold user-1
			expect(list.getSelectedNode()?.entry.id).toBe("user-1");

			selector.handleInput(DOWN); // user-1 → user-2 (children hidden)
			expect(list.getSelectedNode()?.entry.id).toBe("user-2");

			selector.handleInput(CTRL_RIGHT); // user-2 → asst-2（跨段跳转到叶节点）。
			expect(list.getSelectedNode()?.entry.id).toBe("asst-2");

			selector.handleInput(CTRL_LEFT); // asst-2 → user-2
			expect(list.getSelectedNode()?.entry.id).toBe("user-2");

			selector.handleInput(CTRL_LEFT); // fold user-2
			expect(list.getSelectedNode()?.entry.id).toBe("user-2");

			selector.handleInput(CTRL_LEFT); // user-2 (folded, root) → stays on user-2
			expect(list.getSelectedNode()?.entry.id).toBe("user-2");
		});

		test("folding root hides descendants even when intermediate nodes are filtered out", () => {
			// user-1 → toolCallOnly-1 (filtered out) → user-2 → asst-2
			const entries: SessionEntry[] = [
				userMessage("user-1", null, "hello"),
				toolCallOnlyAssistant("tool-asst-1", "user-1"),
				userMessage("user-2", "tool-asst-1", "follow up"),
				assistantMessage("asst-2", "user-2", "response"),
			];
			const tree = buildTree(entries);
			const selector = new TreeSelectorComponent(
				tree,
				"asst-2",
				24,
				() => {},
				() => {},
			);
			const list = selector.getTreeList();

			selector.handleInput(CTRL_LEFT); // asst-2 → user-1
			expect(list.getSelectedNode()?.entry.id).toBe("user-1");

			selector.handleInput(CTRL_LEFT); // fold user-1
			expect(list.getSelectedNode()?.entry.id).toBe("user-1");

			selector.handleInput(DOWN); // 仅有一个可见节点，因此循环回到该节点。
			expect(list.getSelectedNode()?.entry.id).toBe("user-1");
		});

		test("search resets fold state", () => {
			const tree = buildBranchingTree();
			const selector = new TreeSelectorComponent(
				tree,
				"asst-4a",
				24,
				() => {},
				() => {},
			);
			const list = selector.getTreeList();

			selector.handleInput(CTRL_LEFT); // asst-4a → user-3a
			selector.handleInput(CTRL_LEFT); // fold user-3a

			selector.handleInput(DOWN); // user-3a → user-3b (children hidden)
			expect(list.getSelectedNode()?.entry.id).toBe("user-3b");

			selector.handleInput("b"); // search resets folds
			selector.handleInput("\x1b"); // 清空搜索内容。

			// 导航到 user-3a，验证折叠状态已重置。
			let currentId = "";
			for (let i = 0; i < 20; i++) {
				selector.handleInput(DOWN);
				currentId = list.getSelectedNode()?.entry.id ?? "";
				if (currentId === "user-3a") break;
			}
			expect(currentId).toBe("user-3a");

			selector.handleInput(DOWN); // 从 user-3a 移至 asst-3a，而不是 user-3b。
			expect(list.getSelectedNode()?.entry.id).toBe("asst-3a");
		});

		test("filter mode change resets fold state", () => {
			const tree = buildBranchingTree();
			const selector = new TreeSelectorComponent(
				tree,
				"asst-4a",
				24,
				() => {},
				() => {},
			);
			const list = selector.getTreeList();

			selector.handleInput(CTRL_LEFT); // asst-4a → user-3a
			selector.handleInput(CTRL_LEFT); // fold user-3a

			selector.handleInput("\x15"); // Ctrl+U：切换为仅用户消息筛选，并重置折叠状态。
			selector.handleInput("\x04"); // Ctrl+D：切回默认模式。

			// 导航到 user-3a，验证折叠状态已重置。
			let currentId = "";
			for (let i = 0; i < 20; i++) {
				selector.handleInput(DOWN);
				currentId = list.getSelectedNode()?.entry.id ?? "";
				if (currentId === "user-3a") break;
			}
			expect(currentId).toBe("user-3a");

			selector.handleInput(DOWN); // 从 user-3a 移至 asst-3a，而不是 user-3b。
			expect(list.getSelectedNode()?.entry.id).toBe("asst-3a");
		});
	});
});
