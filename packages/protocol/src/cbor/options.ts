export const UINT32_BASE = 0x1_0000_0000;
export const MAX_UINT32 = 0xffff_ffff;
const MAX_CONFIGURED_DEPTH = 512;

/** 针对不可信协议负载的安全默认值。 */
export const DEFAULT_MAX_CBOR_BYTE_LENGTH = 16 * 1024 * 1024;
export const DEFAULT_MAX_CBOR_CONTAINER_LENGTH = 1_000_000;
export const DEFAULT_MAX_CBOR_DEPTH = 64;

export interface CborOptions {
	/** 编码后输入/输出的最大字节数，以及字节串/文本串的最大长度。 */
	maxByteLength?: number;
	/** 数组的最大元素数或映射的最大条目数。 */
	maxContainerLength?: number;
	/** 最大递归项深度。 */
	maxDepth?: number;
}

export interface ResolvedCborOptions {
	maxByteLength: number;
	maxContainerLength: number;
	maxDepth: number;
}

export class CborError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CborError";
	}
}

export const textEncoder = new TextEncoder();
export const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function resolveLimit(name: string, value: number, maximum: number): number {
	if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
		throw new RangeError(`${name} must be an integer between 0 and ${maximum}`);
	}
	return value;
}

export function resolveOptions(options: CborOptions | undefined): ResolvedCborOptions {
	return {
		maxByteLength: resolveLimit("maxByteLength", options?.maxByteLength ?? DEFAULT_MAX_CBOR_BYTE_LENGTH, MAX_UINT32),
		maxContainerLength: resolveLimit(
			"maxContainerLength",
			options?.maxContainerLength ?? DEFAULT_MAX_CBOR_CONTAINER_LENGTH,
			MAX_UINT32,
		),
		maxDepth: resolveLimit("maxDepth", options?.maxDepth ?? DEFAULT_MAX_CBOR_DEPTH, MAX_CONFIGURED_DEPTH),
	};
}
