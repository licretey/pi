import { Container, type SelectItem, SelectList, type SelectListLayoutOptions } from "@earendil-works/pi-tui";
import { getSelectListTheme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";

const SHOW_IMAGES_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
};

/**
 * 用于呈现带边框的图片显示选项选择器。
 */
export class ShowImagesSelectorComponent extends Container {
	private selectList: SelectList;

	constructor(currentValue: boolean, onSelect: (show: boolean) => void, onCancel: () => void) {
		super();

		const items: SelectItem[] = [
			{ value: "yes", label: "Yes", description: "Show images inline in terminal" },
			{ value: "no", label: "No", description: "Show text placeholder instead" },
		];

		// 添加顶部边框。
		this.addChild(new DynamicBorder());

		// 创建选择器。
		this.selectList = new SelectList(items, 5, getSelectListTheme(), SHOW_IMAGES_SELECT_LIST_LAYOUT);

		// 预选当前值。
		this.selectList.setSelectedIndex(currentValue ? 0 : 1);

		this.selectList.onSelect = (item) => {
			onSelect(item.value === "yes");
		};

		this.selectList.onCancel = () => {
			onCancel();
		};

		this.addChild(this.selectList);

		// 添加底部边框。
		this.addChild(new DynamicBorder());
	}

	getSelectList(): SelectList {
		return this.selectList;
	}
}
