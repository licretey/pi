import {
	type Component,
	Container,
	type Focusable,
	getKeybindings,
	Input,
	type Keybinding,
	Spacer,
	sliceByColumn,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { SessionTreeNode } from "../../../core/session-manager.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { formatKeyText, keyHint } from "./keybinding-hints.ts";

/** 檽栏信息：位置（连接符所在处的 displayIndent）以及是否显示 │ */
interface GutterInfo {
	position: number; // 显示连接符时的 displayIndent 层级
	show: boolean; // true = 显示 │，false = 显示空格
}

/** 扁平化的树节点，用于导航 */
interface FlatNode {
	node: SessionTreeNode;
	/** 缩进层级（每级 = 3 字符） */
	indent: number;
	/** 是否显示连接符（├─ 或 └─）——父节点有多个子节点时为 true */
	showConnector: boolean;
	/** 若显示连接符：true = 最后一个兄弟节点（└─），false = 非最后（├─） */
	isLast: boolean;
	/** 每个祖先分支点的檽栏信息 */
	gutters: GutterInfo[];
	/** 若本节点是虚拟分支根下的一个根（多根场景）则为 true */
	isVirtualRootChild: boolean;
}

interface HorizontalViewportRow {
	gutter: string;
	body: string;
	anchorCol: number;
	bodyWidth: number;
	isSelected: boolean;
}

const TREE_GUTTER_WIDTH = 2;
const MIN_VISIBLE_ANCHOR_CONTENT_WIDTH = 4;
const MAX_VISIBLE_ANCHOR_CONTENT_WIDTH = 20;
const MIN_ANCHOR_CONTEXT_WIDTH = 2;
const MAX_ANCHOR_CONTEXT_WIDTH = 12;

/**
 * 将树行渲染进一个水平裁剪的视口。
 *
 * 树的檽栏始终保持可见。只有当选中行的锚点（其条目文本在树缩进/标记之后的起点）
 * 若不处理就会偏到太靠右而看不到有效内容时，行主体才向左平移。
 */
function renderHorizontalViewport(rows: HorizontalViewportRow[], width: number): string[] {
	const viewportWidth = Math.max(0, width - TREE_GUTTER_WIDTH);
	const maxBodyWidth = rows.reduce((max, row) => Math.max(max, row.bodyWidth), 0);
	const maxHorizontalScroll = Math.max(0, maxBodyWidth - viewportWidth);
	const selectedRow = rows.find((row) => row.isSelected);

	// 仅在需要时才水平平移，以保证选中行锚点之后有足够内容可见。
	let horizontalScroll = 0;
	if (selectedRow && maxHorizontalScroll > 0) {
		const minVisibleAnchorContentWidth = Math.min(
			MAX_VISIBLE_ANCHOR_CONTENT_WIDTH,
			Math.max(MIN_VISIBLE_ANCHOR_CONTENT_WIDTH, Math.floor(viewportWidth / 3)),
		);
		if (selectedRow.anchorCol > viewportWidth - minVisibleAnchorContentWidth) {
			const anchorContextWidth = Math.min(
				MAX_ANCHOR_CONTEXT_WIDTH,
				Math.max(MIN_ANCHOR_CONTEXT_WIDTH, Math.floor(viewportWidth / 4)),
			);
			horizontalScroll = Math.min(maxHorizontalScroll, selectedRow.anchorCol - anchorContextWidth);
		}
	}

	// 只裁剪主体；固定宽度的檽栏保留为导航上下文。
	return rows.map((row) => {
		const line =
			horizontalScroll > 0
				? `${row.gutter}${sliceByColumn(row.body, horizontalScroll, viewportWidth, true)}\x1b[0m`
				: row.gutter + row.body;
		return truncateToWidth(line, width, "");
	});
}

/** 树显示的过滤模式 */
export type FilterMode = "default" | "no-tools" | "user-only" | "labeled-only" | "all";

/**
 * 带选择功能和 ASCII 图形呈现的树形列表组件
 */
/** 供查找用的 tool call 信息 */
interface ToolCallInfo {
	name: string;
	arguments: Record<string, unknown>;
}

class TreeList implements Component {
	private flatNodes: FlatNode[] = [];
	private filteredNodes: FlatNode[] = [];
	private selectedIndex = 0;
	private currentLeafId: string | null;
	private maxVisibleLines: number;
	private filterMode: FilterMode = "default";
	private searchQuery = "";
	private toolCallMap: Map<string, ToolCallInfo> = new Map();
	private multipleRoots = false;
	private showLabelTimestamps = false;
	private activePathIds: Set<string> = new Set();
	private visibleParentMap: Map<string, string | null> = new Map();
	private visibleChildrenMap: Map<string | null, string[]> = new Map();
	private lastSelectedId: string | null = null;
	private foldedNodes: Set<string> = new Set();

	public onSelect?: (entryId: string) => void;
	public onCancel?: () => void;
	public onCopy?: (text: string | undefined) => void;
	public onLabelEdit?: (entryId: string, currentLabel: string | undefined) => void;

	constructor(
		tree: SessionTreeNode[],
		currentLeafId: string | null,
		maxVisibleLines: number,
		initialSelectedId?: string,
		initialFilterMode?: FilterMode,
	) {
		this.currentLeafId = currentLeafId;
		this.maxVisibleLines = maxVisibleLines;
		this.filterMode = initialFilterMode ?? "default";
		this.multipleRoots = tree.length > 1;
		this.flatNodes = this.flattenTree(tree);
		this.buildActivePath();
		this.applyFilter();

		// 有 initialSelectedId 时从它开始，否则从当前叶子开始
		const targetId = initialSelectedId ?? currentLeafId;
		this.selectedIndex = this.findNearestVisibleIndex(targetId);
		this.lastSelectedId = this.filteredNodes[this.selectedIndex]?.node.entry.id ?? null;
	}

	/**
	 * 查找最近的可见条目的索引，必要时沿父链向上查找。
	 * 返回 filteredNodes 中的索引，找不到则以最后一项兜底。
	 */
	private findNearestVisibleIndex(entryId: string | null): number {
		if (this.filteredNodes.length === 0) return 0;

		// 构建父节点查找表
		const entryMap = new Map<string, FlatNode>();
		for (const flatNode of this.flatNodes) {
			entryMap.set(flatNode.node.entry.id, flatNode);
		}

		// 构建可见条目 ID 到其在 filteredNodes 中索引的映射
		const visibleIdToIndex = new Map<string, number>(this.filteredNodes.map((node, i) => [node.node.entry.id, i]));

		// 从 entryId 向上走到根，寻找一个可见条目
		let currentId = entryId;
		while (currentId !== null) {
			const index = visibleIdToIndex.get(currentId);
			if (index !== undefined) return index;
			const node = entryMap.get(currentId);
			if (!node) break;
			currentId = node.node.entry.parentId ?? null;
		}

		// 兜底：最后一个可见条目
		return this.filteredNodes.length - 1;
	}

	/** 构建从根到当前叶子路径上的条目 ID 集合 */
	private buildActivePath(): void {
		this.activePathIds.clear();
		if (!this.currentLeafId) return;

		// 构建 id -> entry 的映射用于父节点查找
		const entryMap = new Map<string, FlatNode>();
		for (const flatNode of this.flatNodes) {
			entryMap.set(flatNode.node.entry.id, flatNode);
		}

		// 从叶子向根回溯
		let currentId: string | null = this.currentLeafId;
		while (currentId) {
			this.activePathIds.add(currentId);
			const node = entryMap.get(currentId);
			if (!node) break;
			currentId = node.node.entry.parentId ?? null;
		}
	}

	private flattenTree(roots: SessionTreeNode[]): FlatNode[] {
		const result: FlatNode[] = [];
		this.toolCallMap.clear();

		// 缩进规则：
		// - 在缩进 0：保持 0，除非父节点有 >1 个子节点（则 +1）
		// - 在缩进 1：子节点总是到缩进 2（子树的视觉分组）
		// - 在缩进 2+：单子链保持不变，仅当父节点分支时 +1

		// 栈元素：[node, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild]
		type StackItem = [SessionTreeNode, number, boolean, boolean, boolean, GutterInfo[], boolean];
		const stack: StackItem[] = [];

		// 判断哪些子树包含活动叶子（用于把当前分支排在前面）
		// 使用迭代式后序遍历以避免栈溢出
		const containsActive = new Map<SessionTreeNode, boolean>();
		const leafId = this.currentLeafId;
		{
			// 按前序构建列表，然后逆序处理以获得后序效果
			const allNodes: SessionTreeNode[] = [];
			const preOrderStack: SessionTreeNode[] = [...roots];
			while (preOrderStack.length > 0) {
				const node = preOrderStack.pop()!;
				allNodes.push(node);
				// 逆序压入子节点，使它们按从左到右的顺序被处理
				for (let i = node.children.length - 1; i >= 0; i--) {
					preOrderStack.push(node.children[i]);
				}
			}
			// 逆序处理（后序）：子节点先于父节点
			for (let i = allNodes.length - 1; i >= 0; i--) {
				const node = allNodes[i];
				let has = leafId !== null && node.entry.id === leafId;
				for (const child of node.children) {
					if (containsActive.get(child)) {
						has = true;
					}
				}
				containsActive.set(node, has);
			}
		}

		// 逆序加入根节点，包含活动叶子的根优先
		// 多根时，把它们视为一个会分支的虚拟根的子节点
		const multipleRoots = roots.length > 1;
		const orderedRoots = [...roots].sort((a, b) => Number(containsActive.get(b)) - Number(containsActive.get(a)));
		for (let i = orderedRoots.length - 1; i >= 0; i--) {
			const isLast = i === orderedRoots.length - 1;
			stack.push([orderedRoots[i], multipleRoots ? 1 : 0, multipleRoots, multipleRoots, isLast, [], multipleRoots]);
		}

		while (stack.length > 0) {
			const [node, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild] = stack.pop()!;

			// 从 assistant 消息中提取 tool call 供后续查找
			const entry = node.entry;
			if (entry.type === "message" && entry.message.role === "assistant") {
				const content = (entry.message as { content?: unknown }).content;
				if (Array.isArray(content)) {
					for (const block of content) {
						if (typeof block === "object" && block !== null && "type" in block && block.type === "toolCall") {
							const tc = block as { id: string; name: string; arguments: Record<string, unknown> };
							this.toolCallMap.set(tc.id, { name: tc.name, arguments: tc.arguments });
						}
					}
				}
			}

			result.push({ node, indent, showConnector, isLast, gutters, isVirtualRootChild });

			const children = node.children;
			const multipleChildren = children.length > 1;

			// 调整子节点顺序，让包含活动叶子的分支排在前面
			const orderedChildren = (() => {
				const prioritized: SessionTreeNode[] = [];
				const rest: SessionTreeNode[] = [];
				for (const child of children) {
					if (containsActive.get(child)) {
						prioritized.push(child);
					} else {
						rest.push(child);
					}
				}
				return [...prioritized, ...rest];
			})();

			// 计算子节点缩进
			let childIndent: number;
			if (multipleChildren) {
				// 父节点分支：子节点 +1
				childIndent = indent + 1;
			} else if (justBranched && indent > 0) {
				// 分支后的第一代：+1 以获得视觉分组
				childIndent = indent + 1;
			} else {
				// 单子链：保持不变
				childIndent = indent;
			}

			// 为子节点构建檽栏
			// 若本节点显示了连接符，则为后代加入一条檽栏记录
			// 仅当连接符实际显示时才加入檽栏（虚拟根的子节点不显示）
			const connectorDisplayed = showConnector && !isVirtualRootChild;
			// 连接符显示时，在其所在位置加入一条檽栏记录
			// 连接符位于 (displayIndent - 1) 的位置，因此檽栏也应在那里
			const currentDisplayIndent = this.multipleRoots ? Math.max(0, indent - 1) : indent;
			const connectorPosition = Math.max(0, currentDisplayIndent - 1);
			const childGutters: GutterInfo[] = connectorDisplayed
				? [...gutters, { position: connectorPosition, show: !isLast }]
				: gutters;

			// 逆序加入子节点
			for (let i = orderedChildren.length - 1; i >= 0; i--) {
				const childIsLast = i === orderedChildren.length - 1;
				stack.push([
					orderedChildren[i],
					childIndent,
					multipleChildren,
					multipleChildren,
					childIsLast,
					childGutters,
					false,
				]);
			}
		}

		return result;
	}

	private applyFilter(): void {
		// 仅在当前选择有效（列表非空）时更新 lastSelectedId
		// 这样在空过滤结果之间切换时能保留选择
		if (this.filteredNodes.length > 0) {
			this.lastSelectedId = this.filteredNodes[this.selectedIndex]?.node.entry.id ?? this.lastSelectedId;
		}

		const searchTokens = this.searchQuery.toLowerCase().split(/\s+/).filter(Boolean);

		this.filteredNodes = this.flatNodes.filter((flatNode) => {
			const entry = flatNode.node.entry;
			if (entry.type === "usage") return false;
			const isCurrentLeaf = entry.id === this.currentLeafId;

			// 跳过只有 tool call 而无文本的 assistant 消息（错误/中止的除外）
			// 始终显示当前叶子，让活动位置可见
			if (entry.type === "message" && entry.message.role === "assistant" && !isCurrentLeaf) {
				const msg = entry.message as { stopReason?: string; content?: unknown };
				const hasText = this.hasTextContent(msg.content);
				const isErrorOrAborted = msg.stopReason && msg.stopReason !== "stop" && msg.stopReason !== "toolUse";
				// 仅在既无文本也不是错误/中止消息时才隐藏
				if (!hasText && !isErrorOrAborted) {
					return false;
				}
			}

			// 应用过滤模式
			let passesFilter = true;
			// 默认视图下隐藏的条目类型（设置/记账类）
			const isSettingsEntry =
				entry.type === "label" ||
				entry.type === "context_edit" ||
				entry.type === "custom" ||
				entry.type === "model_change" ||
				entry.type === "thinking_level_change" ||
				entry.type === "session_info";

			switch (this.filterMode) {
				case "user-only":
					// 仅用户消息
					passesFilter = entry.type === "message" && entry.message.role === "user";
					break;
				case "no-tools":
					// 默认模式减去工具结果
					passesFilter = !isSettingsEntry && !(entry.type === "message" && entry.message.role === "toolResult");
					break;
				case "labeled-only":
					// 仅带标签的条目
					passesFilter = flatNode.node.label !== undefined;
					break;
				case "all":
					// 显示全部
					passesFilter = true;
					break;
				default:
					// 默认模式：隐藏设置/记账类条目
					passesFilter = !isSettingsEntry;
					break;
			}

			if (!passesFilter) return false;

			// 应用搜索过滤
			if (searchTokens.length > 0) {
				const nodeText = this.getSearchableText(flatNode.node).toLowerCase();
				return searchTokens.every((token) => nodeText.includes(token));
			}

			return true;
		});

		// 过滤掉已折叠节点的后代。
		if (this.foldedNodes.size > 0) {
			const skipSet = new Set<string>();
			for (const flatNode of this.flatNodes) {
				const { id, parentId } = flatNode.node.entry;
				if (parentId != null && (this.foldedNodes.has(parentId) || skipSet.has(parentId))) {
					skipSet.add(id);
				}
			}
			this.filteredNodes = this.filteredNodes.filter((flatNode) => !skipSet.has(flatNode.node.entry.id));
		}

		// 基于可见树重新计算视觉结构（缩进、连接符、檽栏）
		this.recalculateVisualStructure();

		// 尽量把光标保留在同一节点上，否则就近找可见祖先
		if (this.lastSelectedId) {
			this.selectedIndex = this.findNearestVisibleIndex(this.lastSelectedId);
		} else if (this.selectedIndex >= this.filteredNodes.length) {
			// 索引越界时收敛
			this.selectedIndex = Math.max(0, this.filteredNodes.length - 1);
		}

		// 更新 lastSelectedId 为实际选择（因父链回溯可能已变化）
		if (this.filteredNodes.length > 0) {
			this.lastSelectedId = this.filteredNodes[this.selectedIndex]?.node.entry.id ?? this.lastSelectedId;
		}
	}

	/**
	 * 为过滤后的视图重算缩进/连接符
	 *
	 * 过滤可能隐藏中间条目；后代节点会挂到最近的可见祖先上。
	 * 保持缩进语义与 flattenTree() 一致，避免单子链不断向右漂移。
	 */
	private recalculateVisualStructure(): void {
		if (this.filteredNodes.length === 0) return;

		const visibleIds = new Set(this.filteredNodes.map((n) => n.node.entry.id));

		// 构建条目映射以便高效查找父节点（使用完整树）
		const entryMap = new Map<string, FlatNode>();
		for (const flatNode of this.flatNodes) {
			entryMap.set(flatNode.node.entry.id, flatNode);
		}

		// 为节点找到最近的可见祖先
		const findVisibleAncestor = (nodeId: string): string | null => {
			let currentId = entryMap.get(nodeId)?.node.entry.parentId ?? null;
			while (currentId !== null) {
				if (visibleIds.has(currentId)) {
					return currentId;
				}
				currentId = entryMap.get(currentId)?.node.entry.parentId ?? null;
			}
			return null;
		};

		// 构建可见树结构：
		// - visibleParent：nodeId → 最近的可见祖先（根节点为 null）
		// - visibleChildren：parentId → 可见子节点列表（按 filteredNodes 顺序）
		const visibleParent = new Map<string, string | null>();
		const visibleChildren = new Map<string | null, string[]>();
		visibleChildren.set(null, []); // 顶层根节点

		for (const flatNode of this.filteredNodes) {
			const nodeId = flatNode.node.entry.id;
			const ancestorId = findVisibleAncestor(nodeId);
			visibleParent.set(nodeId, ancestorId);

			if (!visibleChildren.has(ancestorId)) {
				visibleChildren.set(ancestorId, []);
			}
			visibleChildren.get(ancestorId)!.push(nodeId);
		}

		// 根据可见根节点更新 multipleRoots
		const visibleRootIds = visibleChildren.get(null)!;
		this.multipleRoots = visibleRootIds.length > 1;

		// 构建快速查找表：nodeId → FlatNode
		const filteredNodeMap = new Map<string, FlatNode>();
		for (const flatNode of this.filteredNodes) {
			filteredNodeMap.set(flatNode.node.entry.id, flatNode);
		}

		// 按 flattenTree() 的缩进语义对可见树做深度优先遍历
		// 栈元素：[nodeId, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild]
		type StackItem = [string, number, boolean, boolean, boolean, GutterInfo[], boolean];
		const stack: StackItem[] = [];

		// 逆序加入可见根节点（借助栈以正向顺序处理）
		for (let i = visibleRootIds.length - 1; i >= 0; i--) {
			const isLast = i === visibleRootIds.length - 1;
			stack.push([
				visibleRootIds[i],
				this.multipleRoots ? 1 : 0,
				this.multipleRoots,
				this.multipleRoots,
				isLast,
				[],
				this.multipleRoots,
			]);
		}

		while (stack.length > 0) {
			const [nodeId, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild] = stack.pop()!;

			const flatNode = filteredNodeMap.get(nodeId);
			if (!flatNode) continue;

			// 更新本节点的视觉属性
			flatNode.indent = indent;
			flatNode.showConnector = showConnector;
			flatNode.isLast = isLast;
			flatNode.gutters = gutters;
			flatNode.isVirtualRootChild = isVirtualRootChild;

			// 取本节点的可见子节点
			const children = visibleChildren.get(nodeId) || [];
			const multipleChildren = children.length > 1;

			// 子节点缩进遵循 flattenTree()：分支点（以及分支后的第一代）+1
			let childIndent: number;
			if (multipleChildren) {
				childIndent = indent + 1;
			} else if (justBranched && indent > 0) {
				childIndent = indent + 1;
			} else {
				childIndent = indent;
			}

			// 子节点檽栏遵循 flattenTree() 的连接符/檽栏规则
			const connectorDisplayed = showConnector && !isVirtualRootChild;
			const currentDisplayIndent = this.multipleRoots ? Math.max(0, indent - 1) : indent;
			const connectorPosition = Math.max(0, currentDisplayIndent - 1);
			const childGutters: GutterInfo[] = connectorDisplayed
				? [...gutters, { position: connectorPosition, show: !isLast }]
				: gutters;

			// 逆序加入子节点（借助栈以正向顺序处理）
			for (let i = children.length - 1; i >= 0; i--) {
				const childIsLast = i === children.length - 1;
				stack.push([
					children[i],
					childIndent,
					multipleChildren,
					multipleChildren,
					childIsLast,
					childGutters,
					false,
				]);
			}
		}

		// 保存可见树映射，供导航时进行祖先/后代查找
		this.visibleParentMap = visibleParent;
		this.visibleChildrenMap = visibleChildren;
	}

	/** 从节点提取可搜索的文本内容 */
	private getSearchableText(node: SessionTreeNode): string {
		const entry = node.entry;
		const parts: string[] = [];

		if (node.label) {
			parts.push(node.label);
		}

		switch (entry.type) {
			case "message": {
				const msg = entry.message;
				parts.push(msg.role);
				if ("content" in msg && msg.content) {
					parts.push(this.extractContent(msg.content));
				}
				if (msg.role === "bashExecution") {
					const bashMsg = msg as { command?: string };
					if (bashMsg.command) parts.push(bashMsg.command);
				}
				break;
			}
			case "custom_message": {
				parts.push(entry.customType);
				if (typeof entry.content === "string") {
					parts.push(entry.content);
				} else {
					parts.push(this.extractContent(entry.content));
				}
				break;
			}
			case "compaction":
				parts.push("compaction");
				break;
			case "branch_summary":
				parts.push("branch summary", entry.summary);
				break;
			case "session_info":
				parts.push("title");
				if (entry.name) parts.push(entry.name);
				break;
			case "model_change":
				parts.push("model", entry.modelId);
				break;
			case "thinking_level_change":
				parts.push("thinking", entry.thinkingLevel);
				break;
			case "custom":
				parts.push("custom", entry.customType);
				break;
			case "context_edit":
				parts.push("context edit", entry.replacement === null ? "omit" : "replace", entry.targetId);
				break;
			case "label":
				parts.push("label", entry.label ?? "");
				break;
		}

		return parts.join(" ");
	}

	invalidate(): void {}

	getSearchQuery(): string {
		return this.searchQuery;
	}

	getSelectedNode(): SessionTreeNode | undefined {
		return this.filteredNodes[this.selectedIndex]?.node;
	}

	copySelected(): void {
		const node = this.getSelectedNode();
		this.onCopy?.(node ? this.getEntryCopyText(node) : undefined);
	}

	updateNodeLabel(entryId: string, label: string | undefined, labelTimestamp?: string): void {
		for (const flatNode of this.flatNodes) {
			if (flatNode.node.entry.id === entryId) {
				flatNode.node.label = label;
				flatNode.node.labelTimestamp = label ? (labelTimestamp ?? new Date().toISOString()) : undefined;
				break;
			}
		}
	}

	private getStatusLabels(): string {
		let labels = "";
		switch (this.filterMode) {
			case "no-tools":
				labels += " [no-tools]";
				break;
			case "user-only":
				labels += " [user]";
				break;
			case "labeled-only":
				labels += " [labeled]";
				break;
			case "all":
				labels += " [all]";
				break;
		}
		if (this.showLabelTimestamps) {
			labels += " [+label time]";
		}
		return labels;
	}

	render(width: number): string[] {
		const lines: string[] = [];

		if (this.filteredNodes.length === 0) {
			lines.push(truncateToWidth(theme.fg("muted", "  No entries found"), width));
			lines.push(truncateToWidth(theme.fg("muted", `  (0/0)${this.getStatusLabels()}`), width));
			return lines;
		}

		const startIndex = Math.max(
			0,
			Math.min(
				this.selectedIndex - Math.floor(this.maxVisibleLines / 2),
				this.filteredNodes.length - this.maxVisibleLines,
			),
		);
		const endIndex = Math.min(startIndex + this.maxVisibleLines, this.filteredNodes.length);

		const renderedRows: HorizontalViewportRow[] = [];
		for (let i = startIndex; i < endIndex; i++) {
			const flatNode = this.filteredNodes[i];
			const entry = flatNode.node.entry;
			const isSelected = i === this.selectedIndex;

			// 构建行：光标 + 前缀 + 路径标记 + 标签 + 内容
			const cursor = isSelected ? theme.fg("accent", "› ") : "  ";

			// 多根时偏移显示（根在 0 而不是 1）
			const displayIndent = this.multipleRoots ? Math.max(0, flatNode.indent - 1) : flatNode.indent;

			// 在正确位置构建带檽栏的前缀
			// 每条檽栏有一个位置（其连接符显示时的 displayIndent）
			const connector =
				flatNode.showConnector && !flatNode.isVirtualRootChild ? (flatNode.isLast ? "└─ " : "├─ ") : "";
			const connectorPosition = connector ? displayIndent - 1 : -1;

			// 逐字符构建前缀，把檽栏和连接符放到各自的位置
			const totalChars = displayIndent * 3;
			const prefixChars: string[] = [];
			const isFolded = this.foldedNodes.has(entry.id);
			for (let i = 0; i < totalChars; i++) {
				const level = Math.floor(i / 3);
				const posInLevel = i % 3;

				// 检查该层级是否有檽栏
				const gutter = flatNode.gutters.find((g) => g.position === level);
				if (gutter) {
					if (posInLevel === 0) {
						prefixChars.push(gutter.show ? "│" : " ");
					} else {
						prefixChars.push(" ");
					}
				} else if (connector && level === connectorPosition) {
					// 该层级是连接符，并带折叠指示
					if (posInLevel === 0) {
						prefixChars.push(flatNode.isLast ? "└" : "├");
					} else if (posInLevel === 1) {
						const foldable = this.isFoldable(entry.id);
						prefixChars.push(isFolded ? "⊞" : foldable ? "⊟" : "─");
					} else {
						prefixChars.push(" ");
					}
				} else {
					prefixChars.push(" ");
				}
			}
			const prefix = prefixChars.join("");

			// 无连接符节点（根）的折叠标记
			const showsFoldInConnector = flatNode.showConnector && !flatNode.isVirtualRootChild;
			const foldMarker = isFolded && !showsFoldInConnector ? theme.fg("accent", "⊞ ") : "";

			// 活动路径标记——紧跟在条目文本之前显示
			const isOnActivePath = this.activePathIds.has(entry.id);
			const pathMarker = isOnActivePath ? theme.fg("accent", "• ") : "";

			const label = flatNode.node.label ? theme.fg("warning", `[${flatNode.node.label}] `) : "";
			const labelTimestamp =
				this.showLabelTimestamps && flatNode.node.label && flatNode.node.labelTimestamp
					? theme.fg("muted", `${this.formatLabelTimestamp(flatNode.node.labelTimestamp)} `)
					: "";
			const content = this.getEntryDisplayText(flatNode.node, isSelected);
			const prefixPart = theme.fg("dim", prefix) + foldMarker + pathMarker;
			const anchorCol = visibleWidth(prefixPart);
			let gutter = cursor;
			let body = prefixPart + label + labelTimestamp + content;
			if (isSelected) {
				gutter = theme.bg("selectedBg", gutter);
				body = theme.bg("selectedBg", body);
			}
			renderedRows.push({ gutter, body, anchorCol, bodyWidth: visibleWidth(body), isSelected });
		}

		lines.push(...renderHorizontalViewport(renderedRows, width));
		lines.push(
			truncateToWidth(
				theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredNodes.length})${this.getStatusLabels()}`),
				width,
			),
		);

		return lines;
	}

	private getEntryDisplayText(node: SessionTreeNode, isSelected: boolean): string {
		const entry = node.entry;
		let result: string;

		const normalize = (s: string) => s.replace(/[\n\t]/g, " ").trim();

		switch (entry.type) {
			case "message": {
				const msg = entry.message;
				const role = msg.role;
				if (role === "user") {
					const msgWithContent = msg as { content?: unknown };
					const content = normalize(this.extractContent(msgWithContent.content));
					result = theme.fg("accent", "user: ") + content;
				} else if (role === "assistant") {
					const msgWithContent = msg as { content?: unknown; stopReason?: string; errorMessage?: string };
					const textContent = normalize(this.extractContent(msgWithContent.content));
					if (textContent) {
						result = theme.fg("success", "assistant: ") + textContent;
					} else if (msgWithContent.stopReason === "aborted") {
						result = theme.fg("success", "assistant: ") + theme.fg("muted", "(aborted)");
					} else if (msgWithContent.errorMessage) {
						const errMsg = normalize(msgWithContent.errorMessage).slice(0, 80);
						result = theme.fg("success", "assistant: ") + theme.fg("error", errMsg);
					} else {
						result = theme.fg("success", "assistant: ") + theme.fg("muted", "(no content)");
					}
				} else if (role === "toolResult") {
					const toolMsg = msg as { toolCallId?: string; toolName?: string };
					const toolCall = toolMsg.toolCallId ? this.toolCallMap.get(toolMsg.toolCallId) : undefined;
					if (toolCall) {
						result = theme.fg("muted", this.formatToolCall(toolCall.name, toolCall.arguments));
					} else {
						result = theme.fg("muted", `[${toolMsg.toolName ?? "tool"}]`);
					}
				} else if (role === "bashExecution") {
					const bashMsg = msg as { command?: string };
					result = theme.fg("dim", `[bash]: ${normalize(bashMsg.command ?? "")}`);
				} else {
					result = theme.fg("dim", `[${role}]`);
				}
				break;
			}
			case "custom_message": {
				const content =
					typeof entry.content === "string"
						? entry.content
						: entry.content
								.filter((c): c is { type: "text"; text: string } => c.type === "text")
								.map((c) => c.text)
								.join("");
				result = theme.fg("customMessageLabel", `[${entry.customType}]: `) + normalize(content);
				break;
			}
			case "compaction": {
				const tokens = Math.round(entry.tokensBefore / 1000);
				result = theme.fg("borderAccent", `[compaction: ${tokens}k tokens]`);
				break;
			}
			case "branch_summary":
				result = theme.fg("warning", `[branch summary]: `) + normalize(entry.summary);
				break;
			case "model_change":
				result = theme.fg("dim", `[model: ${entry.modelId}]`);
				break;
			case "thinking_level_change":
				result = theme.fg("dim", `[thinking: ${entry.thinkingLevel}]`);
				break;
			case "custom":
				result = theme.fg("dim", `[custom: ${entry.customType}]`);
				break;
			case "context_edit":
				result = theme.fg("dim", `[context ${entry.replacement === null ? "omit" : "replace"}: ${entry.targetId}]`);
				break;
			case "label":
				result = theme.fg("dim", `[label: ${entry.label ?? "(cleared)"}]`);
				break;
			case "session_info":
				result = entry.name
					? [theme.fg("dim", "[title: "), theme.fg("dim", entry.name), theme.fg("dim", "]")].join("")
					: [theme.fg("dim", "[title: "), theme.italic(theme.fg("dim", "empty")), theme.fg("dim", "]")].join("");
				break;
			default:
				result = "";
		}

		return isSelected ? theme.bold(result) : result;
	}

	private formatLabelTimestamp(timestamp: string): string {
		const date = new Date(timestamp);
		const now = new Date();
		const hours = date.getHours().toString().padStart(2, "0");
		const minutes = date.getMinutes().toString().padStart(2, "0");
		const time = `${hours}:${minutes}`;

		if (
			date.getFullYear() === now.getFullYear() &&
			date.getMonth() === now.getMonth() &&
			date.getDate() === now.getDate()
		) {
			return time;
		}

		const month = date.getMonth() + 1;
		const day = date.getDate();
		if (date.getFullYear() === now.getFullYear()) {
			return `${month}/${day} ${time}`;
		}

		const year = date.getFullYear().toString().slice(-2);
		return `${year}/${month}/${day} ${time}`;
	}

	private extractContent(content: unknown): string {
		return this.extractFullContent(content).slice(0, 200);
	}

	private extractFullContent(content: unknown): string {
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";

		let result = "";
		for (const block of content) {
			if (typeof block === "object" && block !== null && "type" in block && block.type === "text") {
				result += (block as { text: string }).text;
			}
		}
		return result;
	}

	private getEntryCopyText(node: SessionTreeNode): string | undefined {
		const entry = node.entry;
		let text: string | undefined;

		switch (entry.type) {
			case "message":
				if (entry.message.role === "bashExecution") {
					text = entry.message.command;
				} else if ("content" in entry.message) {
					text = this.extractFullContent(entry.message.content);
					if (!text && entry.message.role === "assistant") {
						text = entry.message.errorMessage;
					}
				}
				break;
			case "custom_message":
				text = this.extractFullContent(entry.content);
				break;
			case "compaction":
				text = entry.summary;
				break;
			case "branch_summary":
				text = entry.summary;
				break;
		}

		return text?.trim() ? text : undefined;
	}

	private hasTextContent(content: unknown): boolean {
		if (typeof content === "string") return content.trim().length > 0;
		if (Array.isArray(content)) {
			for (const c of content) {
				if (typeof c === "object" && c !== null && "type" in c && c.type === "text") {
					const text = (c as { text?: string }).text;
					if (text && text.trim().length > 0) return true;
				}
			}
		}
		return false;
	}

	private formatToolCall(name: string, args: Record<string, unknown>): string {
		const shortenPath = (p: string): string => {
			const home = process.env.HOME || process.env.USERPROFILE || "";
			if (home && p.startsWith(home)) return `~${p.slice(home.length)}`;
			return p;
		};

		switch (name) {
			case "read": {
				const path = shortenPath(String(args.path || args.file_path || ""));
				const offset = args.offset as number | undefined;
				const limit = args.limit as number | undefined;
				let display = path;
				if (offset !== undefined || limit !== undefined) {
					const start = offset ?? 1;
					const end = limit !== undefined ? start + limit - 1 : "";
					display += `:${start}${end ? `-${end}` : ""}`;
				}
				return `[read: ${display}]`;
			}
			case "write": {
				const path = shortenPath(String(args.path || args.file_path || ""));
				return `[write: ${path}]`;
			}
			case "edit": {
				const path = shortenPath(String(args.path || args.file_path || ""));
				return `[edit: ${path}]`;
			}
			case "bash": {
				const rawCmd = String(args.command || "");
				const cmd = rawCmd
					.replace(/[\n\t]/g, " ")
					.trim()
					.slice(0, 50);
				return `[bash: ${cmd}${rawCmd.length > 50 ? "..." : ""}]`;
			}
			case "grep": {
				const pattern = String(args.pattern || "");
				const path = shortenPath(String(args.path || "."));
				return `[grep: /${pattern}/ in ${path}]`;
			}
			case "find": {
				const pattern = String(args.pattern || "");
				const path = shortenPath(String(args.path || "."));
				return `[find: ${pattern} in ${path}]`;
			}
			case "ls": {
				const path = shortenPath(String(args.path || "."));
				return `[ls: ${path}]`;
			}
			default: {
				// 自定义工具——显示名称和截断的 JSON 参数
				const argsStr = JSON.stringify(args).slice(0, 40);
				return `[${name}: ${argsStr}${JSON.stringify(args).length > 40 ? "..." : ""}]`;
			}
		}
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.up")) {
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredNodes.length - 1 : this.selectedIndex - 1;
		} else if (kb.matches(keyData, "tui.select.down")) {
			this.selectedIndex = this.selectedIndex === this.filteredNodes.length - 1 ? 0 : this.selectedIndex + 1;
		} else if (kb.matches(keyData, "app.tree.foldOrUp")) {
			const currentId = this.filteredNodes[this.selectedIndex]?.node.entry.id;
			if (currentId && this.isFoldable(currentId) && !this.foldedNodes.has(currentId)) {
				this.foldedNodes.add(currentId);
				this.applyFilter();
			} else {
				this.selectedIndex = this.findBranchSegmentStart("up");
			}
		} else if (kb.matches(keyData, "app.tree.unfoldOrDown")) {
			const currentId = this.filteredNodes[this.selectedIndex]?.node.entry.id;
			if (currentId && this.foldedNodes.has(currentId)) {
				this.foldedNodes.delete(currentId);
				this.applyFilter();
			} else {
				this.selectedIndex = this.findBranchSegmentStart("down");
			}
		} else if (kb.matches(keyData, "tui.editor.cursorLeft") || kb.matches(keyData, "tui.select.pageUp")) {
			// 向上翻页
			this.selectedIndex = Math.max(0, this.selectedIndex - this.maxVisibleLines);
		} else if (kb.matches(keyData, "tui.editor.cursorRight") || kb.matches(keyData, "tui.select.pageDown")) {
			// 向下翻页
			this.selectedIndex = Math.min(this.filteredNodes.length - 1, this.selectedIndex + this.maxVisibleLines);
		} else if (kb.matches(keyData, "tui.select.confirm")) {
			const selected = this.filteredNodes[this.selectedIndex];
			if (selected && this.onSelect) {
				this.onSelect(selected.node.entry.id);
			}
		} else if (kb.matches(keyData, "app.message.copy")) {
			this.copySelected();
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			if (this.searchQuery) {
				this.searchQuery = "";
				this.foldedNodes.clear();
				this.applyFilter();
			} else {
				this.onCancel?.();
			}
		} else if (kb.matches(keyData, "app.tree.filter.default")) {
			// 直接切换过滤模式：default
			this.filterMode = "default";
			this.foldedNodes.clear();
			this.applyFilter();
		} else if (kb.matches(keyData, "app.tree.filter.noTools")) {
			// 切换过滤：no-tools ↔ default
			this.filterMode = this.filterMode === "no-tools" ? "default" : "no-tools";
			this.foldedNodes.clear();
			this.applyFilter();
		} else if (kb.matches(keyData, "app.tree.filter.userOnly")) {
			// 切换过滤：user-only ↔ default
			this.filterMode = this.filterMode === "user-only" ? "default" : "user-only";
			this.foldedNodes.clear();
			this.applyFilter();
		} else if (kb.matches(keyData, "app.tree.filter.labeledOnly")) {
			// 切换过滤：labeled-only ↔ default
			this.filterMode = this.filterMode === "labeled-only" ? "default" : "labeled-only";
			this.foldedNodes.clear();
			this.applyFilter();
		} else if (kb.matches(keyData, "app.tree.filter.all")) {
			// 切换过滤：all ↔ default
			this.filterMode = this.filterMode === "all" ? "default" : "all";
			this.foldedNodes.clear();
			this.applyFilter();
		} else if (kb.matches(keyData, "app.tree.filter.cycleBackward")) {
			// 反向轮换过滤模式
			const modes: FilterMode[] = ["default", "no-tools", "user-only", "labeled-only", "all"];
			const currentIndex = modes.indexOf(this.filterMode);
			this.filterMode = modes[(currentIndex - 1 + modes.length) % modes.length];
			this.foldedNodes.clear();
			this.applyFilter();
		} else if (kb.matches(keyData, "app.tree.filter.cycleForward")) {
			// 正向轮换过滤模式：default → no-tools → user-only → labeled-only → all → default
			const modes: FilterMode[] = ["default", "no-tools", "user-only", "labeled-only", "all"];
			const currentIndex = modes.indexOf(this.filterMode);
			this.filterMode = modes[(currentIndex + 1) % modes.length];
			this.foldedNodes.clear();
			this.applyFilter();
		} else if (kb.matches(keyData, "tui.editor.deleteCharBackward")) {
			if (this.searchQuery.length > 0) {
				this.searchQuery = this.searchQuery.slice(0, -1);
				this.foldedNodes.clear();
				this.applyFilter();
			}
		} else if (kb.matches(keyData, "app.tree.editLabel")) {
			const selected = this.filteredNodes[this.selectedIndex];
			if (selected && this.onLabelEdit) {
				this.onLabelEdit(selected.node.entry.id, selected.node.label);
			}
		} else if (kb.matches(keyData, "app.tree.toggleLabelTimestamp")) {
			this.showLabelTimestamps = !this.showLabelTimestamps;
		} else {
			const hasControlChars = [...keyData].some((ch) => {
				const code = ch.charCodeAt(0);
				return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
			});
			if (!hasControlChars && keyData.length > 0) {
				this.searchQuery += keyData;
				this.foldedNodes.clear();
				this.applyFilter();
			}
		}
	}

	/**
	 * 节点是否可折叠。当节点有可见子节点，
	 * 且是根（无可见父节点）或某段起点（可见父节点
	 * 有多个可见子节点）时可折叠。
	 */
	private isFoldable(entryId: string): boolean {
		const children = this.visibleChildrenMap.get(entryId);
		if (!children || children.length === 0) return false;
		const parentId = this.visibleParentMap.get(entryId);
		if (parentId === null || parentId === undefined) return true;
		const siblings = this.visibleChildrenMap.get(parentId);
		return siblings !== undefined && siblings.length > 1;
	}

	/**
	 * 在给定方向上查找下一个分支段起点的索引。
	 * 段起点是分支点的第一个子节点。
	 *
	 * "up" 沿可见父链向上走；"down" 沿可见子节点
	 * 向下走（总是跟随第一个子节点）。
	 */
	private findBranchSegmentStart(direction: "up" | "down"): number {
		const selectedId = this.filteredNodes[this.selectedIndex]?.node.entry.id;
		if (!selectedId) return this.selectedIndex;

		const indexByEntryId = new Map(this.filteredNodes.map((node, i) => [node.node.entry.id, i]));
		let currentId: string = selectedId;
		if (direction === "down") {
			while (true) {
				const children: string[] = this.visibleChildrenMap.get(currentId) ?? [];
				if (children.length === 0) return indexByEntryId.get(currentId)!;
				if (children.length > 1) return indexByEntryId.get(children[0])!;
				currentId = children[0];
			}
		}

		// direction === "up"
		while (true) {
			const parentId: string | null = this.visibleParentMap.get(currentId) ?? null;
			if (parentId === null) return indexByEntryId.get(currentId)!;
			const children = this.visibleChildrenMap.get(parentId) ?? [];
			if (children.length > 1) {
				const segmentStart = indexByEntryId.get(currentId)!;
				if (segmentStart < this.selectedIndex) {
					return segmentStart;
				}
			}
			currentId = parentId;
		}
	}
}

/** 显示当前搜索查询的组件 */
class SearchLine implements Component {
	private treeList: TreeList;

	constructor(treeList: TreeList) {
		this.treeList = treeList;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const query = this.treeList.getSearchQuery();
		if (query) {
			return [truncateToWidth(`  ${theme.fg("muted", "Type to search:")} ${theme.fg("accent", query)}`, width)];
		}
		return [truncateToWidth(`  ${theme.fg("muted", "Type to search:")}`, width)];
	}

	handleInput(_keyData: string): void {}
}

/** 以语义行并按分块感知折行的方式渲染树帮助的组件 */
class TreeHelp implements Component {
	invalidate(): void {}

	render(width: number): string[] {
		const items = TREE_HELP_ITEMS.map(({ keys, label, labelFirst }) => {
			const text = formatHelpKeys(keys);
			if (!text) return label;
			return labelFirst ? `${label} ${text}` : `${text} ${label}`;
		});

		const availableWidth = Math.max(1, width);
		const indent = "  ";
		const separator = " · ";
		const lines: string[] = [];
		let currentLine = "";

		for (const item of items) {
			const candidate = currentLine
				? `${currentLine}${separator}${item}`
				: visibleWidth(`${indent}${item}`) <= availableWidth
					? `${indent}${item}`
					: item;
			if (!currentLine || visibleWidth(candidate) <= availableWidth) {
				currentLine = candidate;
				continue;
			}

			lines.push(...wrapTextWithAnsi(currentLine.trimEnd(), availableWidth));
			currentLine = visibleWidth(`${indent}${item}`) <= availableWidth ? `${indent}${item}` : item;
		}

		if (currentLine) {
			lines.push(...wrapTextWithAnsi(currentLine.trimEnd(), availableWidth));
		}

		return lines.map((line) => theme.fg("muted", line));
	}
}

const TREE_HELP_ITEMS: Array<{ keys: Keybinding[]; label: string; labelFirst?: boolean }> = [
	{ keys: ["tui.select.up", "tui.select.down"], label: "move" },
	{ keys: ["tui.editor.cursorLeft", "tui.editor.cursorRight"], label: "page" },
	{ keys: ["app.tree.foldOrUp", "app.tree.unfoldOrDown"], label: "branch" },
	{ keys: ["app.message.copy"], label: "copy" },
	{ keys: ["app.tree.editLabel"], label: "label" },
	{ keys: ["app.tree.toggleLabelTimestamp"], label: "label time" },
	{
		keys: [
			"app.tree.filter.default",
			"app.tree.filter.noTools",
			"app.tree.filter.userOnly",
			"app.tree.filter.labeledOnly",
			"app.tree.filter.all",
		],
		label: "filters",
		labelFirst: true,
	},
	{ keys: ["app.tree.filter.cycleForward", "app.tree.filter.cycleBackward"], label: "cycle", labelFirst: true },
];

function formatHelpKeys(keybindings: Keybinding[]): string {
	const keys: string[] = [];
	for (const keybinding of keybindings) {
		const key = getKeybindings().getKeys(keybinding)[0];
		if (key !== undefined) keys.push(key);
	}
	if (keys.length === 0) return "";

	return formatKeyText(compactRawKeys(keys))
		.replace(/\bpageUp\b/g, "pgup")
		.replace(/\bpageDown\b/g, "pgdn")
		.replace(/\bup\b/g, "↑")
		.replace(/\bdown\b/g, "↓")
		.replace(/\bleft\b/g, "←")
		.replace(/\bright\b/g, "→");
}

function compactRawKeys(keys: string[]): string {
	if (keys.length === 1) return keys[0]!;

	const parts = keys.map((key) => {
		const separatorIndex = key.lastIndexOf("+");
		return separatorIndex === -1
			? { prefix: "", suffix: key }
			: { prefix: key.slice(0, separatorIndex + 1), suffix: key.slice(separatorIndex + 1) };
	});
	const prefix = parts[0]!.prefix;
	return prefix && parts.every((part) => part.prefix === prefix)
		? `${prefix}${parts.map((part) => part.suffix).join("/")}`
		: keys.join("/");
}

/** 编辑标签时显示的标签输入组件 */
class LabelInput implements Component, Focusable {
	private input: Input;
	private entryId: string;
	public onSubmit?: (entryId: string, label: string | undefined) => void;
	public onCancel?: () => void;

	// Focusable 实现——传播到 input 以进行 IME 光标定位
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	constructor(entryId: string, currentLabel: string | undefined) {
		this.entryId = entryId;
		this.input = new Input();
		if (currentLabel) {
			this.input.setValue(currentLabel);
		}
	}

	invalidate(): void {}

	render(width: number): string[] {
		const lines: string[] = [];
		const indent = "  ";
		const availableWidth = width - indent.length;
		lines.push(truncateToWidth(`${indent}${theme.fg("muted", "Label (empty to remove):")}`, width));
		lines.push(...this.input.render(availableWidth).map((line) => truncateToWidth(`${indent}${line}`, width)));
		lines.push(
			truncateToWidth(
				`${indent}${keyHint("tui.select.confirm", "save")}  ${keyHint("tui.select.cancel", "cancel")}`,
				width,
			),
		);
		return lines;
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.confirm")) {
			const value = this.input.getValue().trim();
			this.onSubmit?.(this.entryId, value || undefined);
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancel?.();
		} else {
			this.input.handleInput(keyData);
		}
	}
}

/**
 * 渲染会话树选择器以供导航的组件
 */
export class TreeSelectorComponent extends Container implements Focusable {
	private treeList: TreeList;
	private labelInput: LabelInput | null = null;
	private labelInputContainer: Container;
	private treeContainer: Container;
	private onLabelChangeCallback?: (entryId: string, label: string | undefined) => void;
	public onCopy?: (text: string | undefined) => void;

	// Focusable 实现——激活时传播到 labelInput 以进行 IME 光标定位
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		// 激活时传播到 labelInput
		if (this.labelInput) {
			this.labelInput.focused = value;
		}
	}

	constructor(
		tree: SessionTreeNode[],
		currentLeafId: string | null,
		terminalHeight: number,
		onSelect: (entryId: string) => void,
		onCancel: () => void,
		onLabelChange?: (entryId: string, label: string | undefined) => void,
		initialSelectedId?: string,
		initialFilterMode?: FilterMode,
	) {
		super();

		this.onLabelChangeCallback = onLabelChange;
		const maxVisibleLines = Math.max(5, Math.floor(terminalHeight / 2));

		this.treeList = new TreeList(tree, currentLeafId, maxVisibleLines, initialSelectedId, initialFilterMode);
		this.treeList.onSelect = onSelect;
		this.treeList.onCancel = onCancel;
		this.treeList.onCopy = (text) => this.onCopy?.(text);
		this.treeList.onLabelEdit = (entryId, currentLabel) => this.showLabelInput(entryId, currentLabel);

		this.treeContainer = new Container();
		this.treeContainer.addChild(this.treeList);

		this.labelInputContainer = new Container();

		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.bold("  Session Tree"), 1, 0));
		this.addChild(new TreeHelp());
		this.addChild(new SearchLine(this.treeList));
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(this.treeContainer);
		this.addChild(this.labelInputContainer);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		if (tree.length === 0) {
			setTimeout(() => onCancel(), 100);
		}
	}

	private showLabelInput(entryId: string, currentLabel: string | undefined): void {
		this.labelInput = new LabelInput(entryId, currentLabel);
		this.labelInput.onSubmit = (id, label) => {
			this.treeList.updateNodeLabel(id, label);
			this.onLabelChangeCallback?.(id, label);
			this.hideLabelInput();
		};
		this.labelInput.onCancel = () => this.hideLabelInput();

		// 把当前焦点状态传播给新的 labelInput
		this.labelInput.focused = this._focused;

		this.treeContainer.clear();
		this.labelInputContainer.clear();
		this.labelInputContainer.addChild(this.labelInput);
	}

	private hideLabelInput(): void {
		this.labelInput = null;
		this.labelInputContainer.clear();
		this.treeContainer.clear();
		this.treeContainer.addChild(this.treeList);
	}

	handleInput(keyData: string): void {
		if (this.labelInput) {
			this.labelInput.handleInput(keyData);
		} else {
			this.treeList.handleInput(keyData);
		}
	}

	getTreeList(): TreeList {
		return this.treeList;
	}
}
