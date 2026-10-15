export interface ModelSearchItem {
	id: string;
	provider: string;
	name?: string;
}

export function getModelSearchText(item: ModelSearchItem): string {
	const { id, provider } = item;
	const name = item.name ? ` ${item.name}` : "";
	return `${id} ${provider} ${provider}/${id} ${provider} ${id}${name}`;
}

/**
 * /model 选择器搜索应优先显示精确匹配的“提供方/模型”查询结果，再显示 openrouter/openai/gpt-5
 * 这类代理提供方 ID，因此裸模型 ID 不应排在最前面。
 */
export function getModelSelectorSearchText(item: ModelSearchItem): string {
	const { id, provider } = item;
	const name = item.name ? ` ${item.name}` : "";
	return `${provider} ${provider}/${id} ${provider} ${id}${name}`;
}
