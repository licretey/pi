/** 事务范围内可变的 JSON 值视图，并保留元组位置。 */
export type Draft<T, Depth extends readonly unknown[] = []> = Depth["length"] extends 8
	? T
	: T extends null | boolean | number | string
		? T
		: T extends (...args: never[]) => unknown
			? T
			: T extends object
				? { -readonly [Key in keyof T]: Draft<T[Key], [...Depth, unknown]> }
				: T;
