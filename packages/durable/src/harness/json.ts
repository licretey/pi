import type { JsonValue } from "@earendil-works/chord";

type JsonContainer = Record<string, JsonValue> | JsonValue[];

/**
 * 逐叶（leaf）地把 `value` 赋到 `target[key]`。Chord 会把对容器的赋值记录为一次完整覆盖（full set），仅当某个字符串
 * 叶子被重新赋值为更长的字符串时才发出追加（append），因此若整体部分性地写入，每次 flush 都会存储并发布完整消息。
 */
export function assignJson(target: JsonContainer, key: string | number, value: JsonValue): void {
	const slots = target as Record<string | number, JsonValue>;
	const current = slots[key];
	if (isRecord(current) && isRecord(value)) {
		for (const name of Object.keys(current)) if (!Object.hasOwn(value, name)) delete current[name];
		for (const [name, child] of Object.entries(value)) assignJson(current, name, child);
		return;
	}
	if (Array.isArray(current) && Array.isArray(value) && current.length <= value.length) {
		const items = current as JsonValue[];
		for (let index = 0; index < value.length; index++) {
			if (index < items.length) assignJson(items, index, value[index]!);
			else items.push(value[index]!);
		}
		return;
	}
	if (current !== value) slots[key] = value;
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
