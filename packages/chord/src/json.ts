import type { JsonValue } from "./types.ts";

const DATA_DESCRIPTOR: PropertyDescriptor = {
	value: undefined,
	writable: true,
	enumerable: true,
	configurable: true,
};

export type CopyJsonOptions = {
	/** 省略值为 undefined 的对象属性，同时保留严格的数组语义。 */
	readonly omitUndefinedProperties?: boolean;
};

/** 将值复制到由调用方持有且不含别名的严格 JSON 树中。 */
export function copyJson(value: unknown, options?: CopyJsonOptions): JsonValue {
	return copy(value, undefined, options?.omitUndefinedProperties === true);
}

function copy(value: unknown, ancestors: Set<object> | undefined, omitUndefinedProperties: boolean): JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (Number.isFinite(value)) return value;
		throw new TypeError("Value contains a non-finite number and is not strict JSON");
	}
	if (typeof value !== "object")
		throw new TypeError(`Value contains a non-JSON ${typeof value}; expected strict JSON`);
	const active = ancestors ?? new Set<object>();
	if (active.has(value)) throw new TypeError("Value contains cycles and is not strict JSON");
	active.add(value);
	try {
		if (Array.isArray(value)) {
			// 只计入数组索引和 `length`：额外属性、Symbol 属性和缺失的键都会改变属性数量。
			if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) {
				throw new TypeError("Value must contain strict JSON dense plain arrays");
			}
			const result = new Array<JsonValue>(value.length);
			for (let index = 0; index < value.length; index++) {
				const descriptor = Object.getOwnPropertyDescriptor(value, index);
				if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
					throw new TypeError("Value must contain strict JSON enumerable indexed data properties");
				}
				defineData(result, String(index), copy(descriptor.value, active, omitUndefinedProperties));
			}
			return result;
		}
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new TypeError("Value must contain strict JSON plain objects or arrays");
		}
		const result = Object.create(prototype) as Record<string, JsonValue>;
		for (const key of Reflect.ownKeys(value)) {
			if (typeof key === "symbol") throw new TypeError("Value contains a symbol key and is not strict JSON");
			const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
			if (!descriptor.enumerable || !("value" in descriptor)) {
				throw new TypeError("Value must contain strict JSON enumerable data properties");
			}
			if (descriptor.value === undefined && omitUndefinedProperties) continue;
			defineData(result, key, copy(descriptor.value, active, omitUndefinedProperties));
		}
		return result;
	} finally {
		active.delete(value);
	}
}

function defineData(target: object, key: PropertyKey, value: JsonValue): void {
	DATA_DESCRIPTOR.value = value;
	Object.defineProperty(target, key, DATA_DESCRIPTOR);
	DATA_DESCRIPTOR.value = undefined;
}

/** 判断值是否为有限的严格 JSON，且仅包含普通对象、不含循环引用。 */
export function isJsonValue(value: unknown): value is JsonValue {
	return check(value, new Set<object>());
}

function check(value: unknown, ancestors: Set<object>): boolean {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) {
		if (Object.getPrototypeOf(value) !== Array.prototype) return false;
		const keys = Reflect.ownKeys(value);
		if (keys.length !== value.length + 1 || keys.some((key) => typeof key !== "string")) return false;
		if (ancestors.has(value)) return false;
		ancestors.add(value);
		try {
			for (let index = 0; index < value.length; index++) {
				const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
				if (
					descriptor === undefined ||
					!descriptor.enumerable ||
					!("value" in descriptor) ||
					!check(descriptor.value, ancestors)
				) {
					return false;
				}
			}
			return true;
		} finally {
			ancestors.delete(value);
		}
	}
	if (typeof value !== "object" || value === null) return false;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return false;
	if (Reflect.ownKeys(value).some((key) => typeof key !== "string")) return false;
	if (ancestors.has(value)) return false;
	ancestors.add(value);
	try {
		for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
			if (!descriptor.enumerable || !("value" in descriptor) || !check(descriptor.value, ancestors)) {
				return false;
			}
		}
		return true;
	} finally {
		ancestors.delete(value);
	}
}
