import {
	type Component,
	Container,
	fuzzyFilter,
	getKeybindings,
	Input,
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";
import { getSelectListTheme, theme } from "../theme/theme.ts";

const SUBMENU_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
};

export interface SelectSubmenuOptions {
	/** 是否启用输入即搜的模糊筛选。 */
	searchable?: boolean;
	/** 覆盖选择列表的布局（列宽）。 */
	layout?: SelectListLayoutOptions;
}

/**
 * 显示带标题选择列表的单步子菜单。
 * `searchable: true` 时，输入文本会通过模糊匹配筛选列表。
 */
export class SelectSubmenu extends Container {
	private selectList: SelectList;
	private listChildIndex: number;
	private allOptions: SelectItem[];
	private listLayout: SelectListLayoutOptions;
	private searchInput: Input | undefined;
	private onSelectCb: (value: string) => void;
	private onCancelCb: () => void;
	private onSelectionChangeCb?: (value: string) => void;

	constructor(
		title: string,
		description: string,
		options: SelectItem[],
		currentValue: string,
		onSelect: (value: string) => void,
		onCancel: () => void,
		onSelectionChange?: (value: string) => void,
		submenuOptions?: SelectSubmenuOptions,
	) {
		super();

		this.allOptions = options;
		this.listLayout = submenuOptions?.layout ?? SUBMENU_SELECT_LIST_LAYOUT;
		this.onSelectCb = onSelect;
		this.onCancelCb = onCancel;
		this.onSelectionChangeCb = onSelectionChange;

		// 标题。
		this.addChild(new Text(theme.bold(theme.fg("accent", title)), 0, 0));

		// 说明。
		if (description) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", description), 0, 0));
		}

		// 搜索输入框。
		if (submenuOptions?.searchable) {
			this.addChild(new Spacer(1));
			this.searchInput = new Input();
			this.searchInput.onSubmit = () => {
				this.selectList.handleInput("\r");
			};
			this.addChild(this.searchInput);
		}

		// 间隔。
		this.addChild(new Spacer(1));

		// 选择列表。
		this.selectList = this.buildSelectList(options, currentValue);
		this.listChildIndex = this.children.length;
		this.addChild(this.selectList);

		// 操作提示。
		this.addChild(new Spacer(1));
		const hint = submenuOptions?.searchable
			? "  Type to filter \u00b7 Enter to select \u00b7 Esc to go back"
			: "  Enter to select \u00b7 Esc to go back";
		this.addChild(new Text(theme.fg("dim", hint), 0, 0));
	}

	private buildSelectList(options: SelectItem[], preselect: string): SelectList {
		const list = new SelectList(options, Math.min(options.length, 10), getSelectListTheme(), this.listLayout);

		const idx = options.findIndex((o) => o.value === preselect);
		if (idx !== -1) list.setSelectedIndex(idx);

		list.onSelect = (item) => this.onSelectCb(item.value);
		list.onCancel = this.onCancelCb;
		if (this.onSelectionChangeCb) {
			const cb = this.onSelectionChangeCb;
			list.onSelectionChange = (item) => cb(item.value);
		}

		return list;
	}

	private applyFilter(query: string): void {
		const filtered = query
			? fuzzyFilter(this.allOptions, query, (item) => `${item.label} ${item.description ?? ""}`)
			: this.allOptions;

		const newList = this.buildSelectList(filtered, "");
		this.children[this.listChildIndex] = newList;
		this.selectList = newList;
	}

	handleInput(data: string): void {
		if (this.searchInput) {
			const kb = getKeybindings();
			const isNav =
				kb.matches(data, "tui.select.up") ||
				kb.matches(data, "tui.select.down") ||
				kb.matches(data, "tui.select.confirm") ||
				kb.matches(data, "tui.select.cancel");
			if (isNav) {
				this.selectList.handleInput(data);
			} else {
				this.searchInput.handleInput(data);
				this.applyFilter(this.searchInput.getValue());
			}
		} else {
			this.selectList.handleInput(data);
		}
	}
}

// ============================================================================
// SteppedSubmenu：可复用的多步骤选择器。
// ============================================================================

/** {@link SteppedSubmenu} 中的一个步骤。 */
export interface SteppedSubmenuStep {
	/** 唯一键；选中值会使用此键存入结果上下文。 */
	key: string;
	/** 步骤顶部显示的标题；可读取此前已选的值。 */
	title: string | ((context: Record<string, string>) => string);
	/** 标题下方显示的说明；可读取此前已选的值。 */
	description: string | ((context: Record<string, string>) => string);
	/** 构建此步骤的选项列表；每次显示步骤时都会重新调用。 */
	options: (context: Record<string, string>) => SelectItem[];
	/** 进入此步骤时可选地预先选中一个值。 */
	preselect?: (context: Record<string, string>) => string | undefined;
	/** 是否为此步骤启用输入即搜的模糊筛选。 */
	searchable?: boolean;
	/** 覆盖此步骤选择列表的布局（列宽）。 */
	layout?: SelectListLayoutOptions;
}

interface SteppedSubmenuOptions {
	/** 从此步骤索引开始（从 0 计数），跳过更早的步骤；被跳过步骤的键必须在 initialContext 中提供。 */
	startAtStep?: number;
	/** 为跳过的步骤预填选中值。 */
	initialContext?: Record<string, string>;
	/** 完成最后一步后回到第 0 步，而不是关闭子菜单。 */
	loop?: boolean;
}

/**
 * 基于 {@link SelectSubmenu} 构建的通用多步骤子菜单。
 *
 * 每一步的选项都可以通过共享上下文依赖此前的选择。
 * 按 Esc 返回上一步；在第 0 步按 Esc 则取消。
 * `loop: true` 时，完成最后一步会调用 `onComplete`，然后返回第 0 步。
 */
export class SteppedSubmenu extends Container {
	private readonly steps: SteppedSubmenuStep[];
	private readonly onComplete: (context: Record<string, string>) => void;
	private readonly onCancel: () => void;
	private readonly opts: SteppedSubmenuOptions;
	private activeComponent: Component;
	private context: Record<string, string>;

	constructor(
		steps: SteppedSubmenuStep[],
		onComplete: (context: Record<string, string>) => void,
		onCancel: () => void,
		opts: SteppedSubmenuOptions = {},
	) {
		super();
		this.steps = steps;
		this.onComplete = onComplete;
		this.onCancel = onCancel;
		this.opts = opts;
		this.context = { ...(opts.initialContext ?? {}) };
		this.activeComponent = this.buildStep(opts.startAtStep ?? 0);
	}

	private buildStep(stepIndex: number): Component {
		const step = this.steps[stepIndex];
		const total = this.steps.length;
		const stepLabel = total > 1 ? `Step ${stepIndex + 1}/${total} \u00b7 ` : "";

		const title = typeof step.title === "function" ? step.title(this.context) : step.title;
		const desc = typeof step.description === "function" ? step.description(this.context) : step.description;
		const items = step.options(this.context);
		const preselect = step.preselect?.(this.context) ?? "";

		return new SelectSubmenu(
			title,
			`${stepLabel}${desc}`,
			items,
			preselect,
			(value) => {
				this.context[step.key] = value;

				if (stepIndex < total - 1) {
					// 进入下一步。
					this.activeComponent = this.buildStep(stepIndex + 1);
				} else {
					// 最后一步：交付结果。
					this.onComplete({ ...this.context });

					if (this.opts.loop) {
						this.context = {};
						this.activeComponent = this.buildStep(0);
					} else {
						this.onCancel();
					}
				}
			},
			() => {
				if (stepIndex > 0) {
					delete this.context[step.key];
					this.activeComponent = this.buildStep(stepIndex - 1);
				} else {
					this.onCancel();
				}
			},
			undefined,
			step.searchable || step.layout ? { searchable: step.searchable, layout: step.layout } : undefined,
		);
	}

	render(width: number): string[] {
		return this.activeComponent.render(width);
	}

	handleInput(data: string): void {
		this.activeComponent.handleInput?.(data);
	}

	invalidate(): void {
		this.activeComponent.invalidate?.();
	}
}
