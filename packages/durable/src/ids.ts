import type { Id, Seq } from "./types.ts";

/** 在可信的数字分配或解码边界处套上已被擦除的 ID 品牌（brand）。 */
export function idFromNumber<I extends Id<string>>(value: number): I {
	return value as I;
}

/** 在可信的存储边界处套上已被擦除的提交序号品牌（brand）。 */
export function seqFromNumber(value: number): Seq {
	return value as Seq;
}
