import type { JsonValue } from "../types.ts";

export type { JsonValue } from "../types.ts";

const isObj = (value: unknown): value is object => value !== null && typeof value === "object";

// ─────────────────────────────────────────────────────────────────────────────
// chord/delta：针对纯 JSON 的不可变修订跟踪与操作。
//
// 不依赖运行框架中的其他模块。会话存储、运行时和 facet 宿主依赖此模块；请保持依赖方向不变。
// ─────────────────────────────────────────────────────────────────────────────

export type Seg = string | number;
export type Path = readonly Seg[];
export type NonEmptyPath = readonly [Seg, ...Seg[]];

/** 内联存储的路径，或编码器在第二次使用时分配的 ID。 */
export type PathRef<P extends Path = Path> = P | number;

/**
 * 元组是统一的数据形式：内存中、线上传输时和磁盘存储时都使用元组。
 *
 * `r` 是唯一可以替换整个值的操作。类型定义禁止 `s`/`d`/`a`/`t` 作用于
 * 根节点；`p` 和 `m` 可以用于根节点，因为被跟踪的值本身可能是数组。
 * 操作形式并非唯一：数组既可以通过替换清空，也可以通过根节点 splice 操作清空。
 *
 * `Op` 不涉及路径字典。路径驻留、ID 引用和省略路径的形式定义在 `WireOp` 中，
 * 只会在 `encode` 与 `decode` 之间使用。
 */
export type Op =
	| readonly ["r", JsonValue]
	| readonly ["s", NonEmptyPath, JsonValue]
	| readonly ["d", NonEmptyPath]
	| readonly ["a", NonEmptyPath, string]
	| readonly ["t", NonEmptyPath, number]
	| readonly ["p", Path, number, number, JsonValue[]]
	/** 原地重排数组：`new[i] = old[permutation[i]]`。 */
	| readonly ["m", Path, number[]];

/**
 * 跨边界传输的数据格式。只增加两种压缩方式：
 *
 *   ["#", id, path]    定义 ID，在路径第二次使用时发出
 *   数字形式的 PathRef  引用之前定义的 ID
 *   缩短的元组          复用前一个操作的路径；通过元组长度区分形式
 *
 * ["r", value] 不携带路径，因此编码后保持不变；这也是 isBase
 * 两种词汇表均可直接使用此格式。
 */
export type WireOp =
	| readonly ["r", JsonValue]
	| readonly ["s", PathRef<NonEmptyPath>, JsonValue]
	| readonly ["s", JsonValue]
	| readonly ["d", PathRef<NonEmptyPath>]
	| readonly ["d"]
	| readonly ["a", PathRef<NonEmptyPath>, string]
	| readonly ["a", string]
	| readonly ["t", PathRef<NonEmptyPath>, number]
	| readonly ["t", number]
	| readonly ["p", PathRef, number, number, JsonValue[]]
	| readonly ["p", number, number, JsonValue[]]
	| readonly ["m", PathRef, number[]]
	| readonly ["m", number[]]
	| readonly ["#", number, Path];

// ─── 分类 ────────────────────────────────────────────────────────────────────

export const isReplace = (op: Op | WireOp): boolean => op[0] === "r";

/**
 * 批次以替换操作开头。Flush 保证 `r` 位于索引 0，或完全不存在，
 * 因此这里依据的是确定规则，而非启发式判断。
 */
export const isBase = (ops: readonly (Op | WireOp)[]): boolean => ops.length > 0 && ops[0]![0] === "r";

// ─── 重叠计算 ────────────────────────────────────────────────────────────────

/**
 * 求 `a` 的最长后缀，使其同时是 `b` 的前缀。使用 indexOf 查找候选并校验子串完全相等，
 * 从而让热点循环由原生实现执行。手写 KMP 的渐进复杂度相同，但实际运行慢得多。
 *
 * 结果始终正确：返回的 n 满足 a.slice(a.length - n) === b.slice(0, n)。
 */
export function overlap(a: string, b: string, scan: number, probe = 64, maxCandidates = 8): number {
	if (a.length === 0 || b.length === 0 || scan === 0) return 0;
	const tail = a.length > scan ? a.slice(a.length - scan) : a;

	// 长度为 h 的探测只能找到长度至少为 h 的重叠——该头部必须实际出现在 `a` 中。
	// 因此先尝试较长的头部（候选较少，也能找到滑动窗口产生的大块重叠），
	// 再回退到单个字符；这样能找到任意重叠，但候选数会更多。
	//
	// 候选数量设有上限，因为重复输出（例如构建日志或连续重复同一字符）可能导致长头部在数千个位置匹配。
	// 达到上限后放弃搜索并返回 0，此时会生成较大的 set 操作，但结果不会错误。
	for (const h of [Math.min(probe, b.length), 1]) {
		const head = b.slice(0, h);
		let tried = 0;
		for (let k = tail.indexOf(head); k !== -1; k = tail.indexOf(head, k + 1)) {
			if (++tried > maxCandidates) break;
			const n = tail.length - k;
			if (n <= b.length && tail.slice(k) === b.slice(0, n)) return n;
		}
		if (h === 1) break;
	}
	return 0;
}

// ─── 不可变修订跟踪 ─────────────────────────────────────────────────────────

export { diffRevisions } from "./diff.ts";
export type { Draft } from "./draft.ts";
export { type Change, type Prepared, type Tracker, track } from "./tracker.ts";

// ─── 路径安全 ────────────────────────────────────────────────────────────────

/**
 * 会沿原型链继续访问的路径段。
 *
 * 单独使用 `JSON.parse` 是安全的——它会将 `__proto__` 创建为自有属性。真正
 * 不安全的操作是 `parent[key] = value`，而操作应用器恰好会执行这种赋值。路径本身也是数据：
 * `["s", ["__proto__", "isAdmin"], true]` 会污染
 * 会污染整个进程的 `Object.prototype`。
 *
 * 操作可能来自 facet、插件隔离区或会回显模型输出的工具，因此所有输入都不可信。
 */
export const RESERVED_SEGMENTS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

export class UnsafePathError extends Error {
	// 这里不能使用参数属性：Node 的 --experimental-strip-types 不支持参数属性，
	// 而这些文件需要由该模式直接运行。
	readonly segment: Seg;
	constructor(segment: Seg) {
		super(`unsafe path segment: ${String(segment)}`);
		this.segment = segment;
		this.name = "UnsafePathError";
	}
}

/**
 * **解码后**操作的动词、元组长度和负载结构：路径直接内嵌，不包含 `#` 或简写形式。`apply` 使用此类型。
 *
 * 若使用通信格式的语法校验 `Op`，校验会比类型本身宽松：两元素的 `["s", value]` 也会通过，
 * 随后 `apply` 会把 value 当作路径读取。每种词汇表都使用与自身匹配的校验器。
 */
export function assertValidOp(op: unknown): asserts op is Op {
	if (!Array.isArray(op) || op.length === 0) throw new TypeError("op is not a tuple");
	switch (op[0]) {
		case "r":
			if (op.length !== 2) throw new TypeError("r arity");
			return;
		case "s":
			if (op.length !== 3) throw new TypeError("s arity");
			assertPathArg(op[1], true);
			return;
		case "d":
			if (op.length !== 2) throw new TypeError("d arity");
			assertPathArg(op[1], true);
			return;
		case "a":
			if (op.length !== 3 || typeof op[2] !== "string") throw new TypeError("a shape");
			assertPathArg(op[1], true);
			return;
		case "t":
			if (op.length !== 3 || !Number.isInteger(op[2]) || op[2] < 0) throw new TypeError("t shape");
			assertPathArg(op[1], true);
			return;
		case "p": {
			if (op.length !== 5) throw new TypeError("p arity");
			assertPathArg(op[1]);
			if (!Number.isInteger(op[2]) || op[2] < 0) throw new TypeError("p index");
			if (!Number.isInteger(op[3]) || op[3] < 0) throw new TypeError("p remove");
			if (!Array.isArray(op[4])) throw new TypeError("p items");
			return;
		}
		case "m":
			if (op.length !== 3) throw new TypeError("m arity");
			assertPathArg(op[1]);
			assertPermutation(op[2]);
			return;
		// 静默跳过未知动词会导致较新生产方发出的操作丢失。
		default:
			throw new TypeError(`unknown op verb: ${String(op[0])}`);
	}
}

function assertPathArg(p: unknown, nonEmpty = false): void {
	if (!Array.isArray(p)) throw new TypeError("path is not an array");
	if (nonEmpty && p.length === 0) throw new TypeError("path is empty");
	assertSafePath(p as Path);
}

function assertPermutation(value: unknown): asserts value is number[] {
	if (!Array.isArray(value)) throw new TypeError("m permutation is not an array");
	const seen = new Uint8Array(value.length);
	for (const index of value) {
		if (!Number.isInteger(index) || index < 0 || index >= value.length || seen[index] !== 0) {
			throw new TypeError("m permutation is not a bijection");
		}
		seen[index] = 1;
	}
}

/** 对线格式执行相同操作；此处允许使用 ID 和简写形式。 */
export function assertValidWireOp(op: unknown): asserts op is WireOp {
	if (!Array.isArray(op) || op.length === 0) throw new TypeError("op is not a tuple");
	const [verb] = op as unknown[];
	const okRef = (r: unknown): void => {
		if (typeof r === "number") {
			if (!Number.isInteger(r) || r < 0) throw new TypeError("bad path id");
			return;
		}
		// 字符串不是路径。如果不校验，`"a".slice(0, -1)` 会得到 `""`，
		// 继而解析为根节点并向其写入；这会错误地接受一个并非路径的值。
		if (!Array.isArray(r)) throw new TypeError("path is not an array");
		assertSafePath(r as Path);
	};
	switch (verb) {
		case "r":
			if (op.length !== 2) throw new TypeError("r arity");
			return;
		case "s":
			if (op.length === 3) okRef(op[1]);
			else if (op.length !== 2) throw new TypeError("s arity");
			return;
		case "d":
			if (op.length === 2) okRef(op[1]);
			else if (op.length !== 1) throw new TypeError("d arity");
			return;
		case "a":
			if (op.length === 3) {
				okRef(op[1]);
				if (typeof op[2] !== "string") throw new TypeError("a value");
			} else if (op.length === 2) {
				if (typeof op[1] !== "string") throw new TypeError("a value");
			} else throw new TypeError("a arity");
			return;
		case "t":
			if (op.length === 3) {
				okRef(op[1]);
				if (!Number.isInteger(op[2]) || (op[2] as number) < 0) throw new TypeError("t count");
			} else if (op.length === 2) {
				if (!Number.isInteger(op[1]) || (op[1] as number) < 0) throw new TypeError("t count");
			} else throw new TypeError("t arity");
			return;
		case "p": {
			const [i, r, items] = op.length === 5 ? [op[2], op[3], op[4]] : op.length === 4 ? [op[1], op[2], op[3]] : [];
			if (items === undefined) throw new TypeError("p arity");
			if (op.length === 5) okRef(op[1]);
			if (!Number.isInteger(i) || (i as number) < 0) throw new TypeError("p index");
			if (!Number.isInteger(r) || (r as number) < 0) throw new TypeError("p remove");
			if (!Array.isArray(items)) throw new TypeError("p items");
			return;
		}
		case "m":
			if (op.length === 3) okRef(op[1]);
			else if (op.length !== 2) throw new TypeError("m arity");
			assertPermutation(op[op.length - 1]);
			return;
		case "#": {
			if (op.length !== 3 || !Number.isInteger(op[1]) || (op[1] as number) < 0 || !Array.isArray(op[2])) {
				throw new TypeError("# shape");
			}
			assertSafePath(op[2] as Path);
			return;
		}
		// 静默跳过未知动词会导致较新生产方发出的操作丢失。
		default:
			throw new TypeError(`unknown op verb: ${String(verb)}`);
	}
}

export function assertSafePath(path: Path): void {
	for (const seg of path) {
		if (typeof seg === "string") {
			if (RESERVED_SEGMENTS.has(seg)) throw new UnsafePathError(seg);
		} else if (!Number.isInteger(seg) || seg < 0) {
			throw new UnsafePathError(seg);
		}
	}
}

/**
 * 索引可以指向已有元素，也可以恰好指向数组末尾之后的位置以追加元素。
 *
 * 这不是随意设置的上限，而是为了保证值仍属于 `JsonValue`。稀疏数组无法在 JSON 往返后保持原样：空洞会序列化为 `null`，
 * 解析后变为实际属性。因此对长度为 3 的数组执行 `arr[7] = x`，会产生副本无法匹配的状态。
 * 拒绝这种写入，以免静默地产生不一致状态。
 *
 * 这样也能避免由此造成的拒绝服务风险：
 * `["s", ["xs", 4294967290], 1]` 这样的单条操作会分配一个包含 42.9 亿个元素的数组。
 * 数组仍可增长，但操作成本与增长幅度成正比：跟踪器会为每个新增元素生成对应操作，
 * 因此较大的增长会产生较大的操作，而不会被压缩成一条很小的操作。
 */
function assertIndexInRange(parent: readonly unknown[], index: number): void {
	if (index > parent.length) throw new UnsafePathError(index);
}

// ─── 操作应用器 ─────────────────────────────────────────────────────────────

export class PathError extends Error {
	readonly path: Path | number;
	constructor(path: Path | number) {
		super(`unresolvable path: ${JSON.stringify(path)}`);
		this.path = path;
		this.name = "PathError";
	}
}

/**
 * 将操作应用到普通可变值上并返回结果，因为 `r` 会整体替换根值，无法原地完成。
 *
 * 接受已解码的操作。路径 ID 和省略路径属于通信格式的处理范畴——请先调用
 * 若操作来自外部边界，请先调用 `decode`。
 */
export function apply<T>(target: T | undefined, ops: readonly Op[]): T {
	return applyOps(target, ops);
}

function applyOps<T>(target: T | undefined, ops: readonly Op[]): T {
	let root = target as unknown as JsonValue;

	for (const op of ops) {
		assertValidOp(op);
		if (op[0] === "r") {
			// 接管而非复制。消费者拥有收到的这个批次。
			//
			// 因此，在同一进程中将一个批次分发给多个消费者，会使它们的副本引用同一对象。
			// 这是所有权规则，并非缺陷：可以在分发时复制批次，或让每个消费者自行解码。
			// 批次跨越实际边界时则天然彼此独立，因为序列化会生成新对象。
			root = op[1];
			continue;
		}

		const path = op[1];
		assertSafePath(path);

		if (op[0] === "p") {
			const target_ = path.length === 0 ? root : resolve(root, path);
			if (!Array.isArray(target_)) throw new PathError(path);
			target_.splice(op[2], op[3]);
			const chunkSize = 10_000;
			for (let offset = 0; offset < op[4].length; offset += chunkSize) {
				target_.splice(op[2] + offset, 0, ...op[4].slice(offset, offset + chunkSize));
			}
			continue;
		}
		if (op[0] === "m") {
			const target_ = path.length === 0 ? root : resolve(root, path);
			if (!Array.isArray(target_) || target_.length !== op[2].length) throw new PathError(path);
			const previous = target_.slice();
			for (let index = 0; index < op[2].length; index++) target_[index] = previous[op[2][index]!]!;
			continue;
		}

		// s/d/a/t 操作不能作用于根节点；类型定义已禁止这种情况。
		const parent = resolve(root, path.slice(0, -1)) as Record<Seg, JsonValue>;
		const key = path[path.length - 1]!;
		if (Array.isArray(parent)) {
			if (typeof key !== "number") throw new UnsafePathError(key);
			assertIndexInRange(parent, key);
		}
		// 使用 defineProperty 而非直接赋值，否则写入时会触发从原型链继承的 setter。
		const write = (value: JsonValue) => {
			Object.defineProperty(parent, key, { value, writable: true, enumerable: true, configurable: true });
		};
		const read = (): unknown => (Object.hasOwn(parent, key) ? parent[key] : undefined);
		switch (op[0]) {
			case "s":
				write(op[2]);
				break;
			case "d":
				if (Array.isArray(parent)) {
					if (typeof key !== "number" || key >= parent.length) throw new PathError(path);
					(parent as unknown as JsonValue[]).splice(key, 1);
				} else delete parent[key];
				break;
			case "a": {
				const current = read();
				if (typeof current !== "string") throw new PathError(path);
				write(`${current}${op[2]}`);
				break;
			}
			case "t": {
				const current = read();
				if (typeof current !== "string") throw new PathError(path);
				write(current.slice(op[2]));
				break;
			}
		}
	}
	return root as unknown as T;
}

/** 应用一批已解码操作，同时不修改之前的不可变值。 */
export function applyImmutable<T>(target: T | undefined, ops: readonly Op[]): T {
	return applyImmutableBatches(target, [ops]);
}

/**
 * 依次应用已解码的操作批次，只返回最终结果。
 *
 * 应用后续批次时，早期批次复制的容器可能会被修改，因此这里有意不暴露中间修订版本。
 */
export function applyImmutableBatches<T>(target: T | undefined, batches: Iterable<readonly Op[]>): T {
	let root = target as unknown as JsonValue;
	const owned = new WeakSet<object>();
	for (const ops of batches) {
		for (const op of ops) {
			assertValidOp(op);
			if (op[0] === "r") {
				root = op[1];
				continue;
			}
			root = copyContainers(root, op[0] === "p" || op[0] === "m" ? op[1] : op[1].slice(0, -1), owned);
			root = applyOps(root, [op]);
		}
	}
	return root as unknown as T;
}

function copyContainers(root: JsonValue, path: Path, owned: WeakSet<object>): JsonValue {
	const copy = (value: JsonValue): JsonValue[] | Record<string, JsonValue> => {
		if (Array.isArray(value)) return value.slice();
		if (!isObj(value)) throw new PathError(path);
		const result = Object.create(Object.getPrototypeOf(value) === null ? null : Object.prototype) as Record<
			string,
			JsonValue
		>;
		for (const key of Object.keys(value)) {
			Object.defineProperty(result, key, {
				value: (value as Record<string, JsonValue>)[key],
				writable: true,
				enumerable: true,
				configurable: true,
			});
		}
		return result;
	};
	if (!isObj(root)) throw new PathError(path);
	let copiedRoot: JsonValue[] | Record<string, JsonValue>;
	if (owned.has(root)) copiedRoot = root as JsonValue[] | Record<string, JsonValue>;
	else {
		copiedRoot = copy(root);
		owned.add(copiedRoot);
	}
	let destination = copiedRoot;
	for (const segment of path) {
		if (!Object.hasOwn(destination, segment)) throw new PathError(path);
		if (Array.isArray(destination) && typeof segment !== "number") throw new UnsafePathError(segment);
		const child = (destination as Record<Seg, JsonValue>)[segment]!;
		if (!isObj(child)) throw new PathError(path);
		if (owned.has(child)) {
			destination = child as JsonValue[] | Record<string, JsonValue>;
			continue;
		}
		const copiedChild = copy(child);
		Object.defineProperty(destination, segment, {
			value: copiedChild,
			writable: true,
			enumerable: true,
			configurable: true,
		});
		owned.add(copiedChild);
		destination = copiedChild;
	}
	return copiedRoot;
}

function resolveValue(root: JsonValue, path: Path): JsonValue {
	let node: JsonValue = root;
	for (const seg of path) {
		if (!isObj(node)) throw new PathError(path);
		if (Array.isArray(node) && typeof seg !== "number") throw new UnsafePathError(seg);
		// 只处理自有属性：不能触发继承的 getter，也不能在遍历时沿原型链离开当前值。
		if (!Object.hasOwn(node, seg as PropertyKey)) throw new PathError(path);
		node = (node as Record<Seg, JsonValue>)[seg]!;
	}
	return node;
}

function resolve(root: JsonValue, path: Path): JsonValue {
	const node = resolveValue(root, path);
	if (!isObj(node)) throw new PathError(path);
	return node;
}

// ─── 编解码器 ───────────────────────────────────────────────────────────────
//
// 路径驻留和元组长度省略逻辑位于跟踪器与通信边界之间；
// `Op` 和 `apply` 不涉及这些机制。
//
// 每个独立状态流必须拥有一对独立的编码器和解码器。每个解码器必须严格接收对应编码器产生的批次，
// 并从该状态的基准批次开始。即使共用同一传输连接，也不意味着分别水合的状态可以合并为一个流。
// 流。

const pathKey = (path: Path): string => JSON.stringify(path);

export interface Encoder {
	encode(ops: readonly Op[]): WireOp[];
}

/**
 * 在第二次使用时才驻留路径。定义项的开销大于它替换的路径，因此首次使用就驻留会增加只写入一次的路径的成本。
 */
export function encoder(): Encoder {
	const seen = new Set<string>();
	const ids = new Map<string, number>();
	let nextId = 0;
	let previous: string | undefined; // 当前批次中的上一个路径

	return {
		encode(ops) {
			// 元组长度省略仅在单个批次内有效。若跨批次生效，则一个批次的首个操作会依赖前一批次的末个操作，
			// 跳过或重排批次的读取方就会将路径解码错误。ID 是唯一允许跨批次保留的状态，字典会明确记录这些 ID。
			previous = undefined;
			const out: WireOp[] = [];
			for (const op of ops) {
				if (op[0] === "r") {
					out.push(op);
					// 基准批次是恢复点：读取方会从最近的基准批次开始，使用新的解码器重放。因此其后的内容必须自包含。
					// 替换后继续保留 ID 会生成指向读取方从未见过的定义项的引用，导致恢复时无法解析路径 ID。
					seen.clear();
					ids.clear();
					nextId = 0;
					previous = undefined;
					continue;
				}
				const path = op[1];
				const key = pathKey(path);

				// 路径与前一个操作相同：完全省略路径引用。
				if (key === previous) {
					switch (op[0]) {
						case "s":
							out.push(["s", op[2]]);
							break;
						case "d":
							out.push(["d"]);
							break;
						case "a":
							out.push(["a", op[2]]);
							break;
						case "t":
							out.push(["t", op[2]]);
							break;
						case "p":
							out.push(["p", op[2], op[3], op[4]]);
							break;
						case "m":
							out.push(["m", op[2]]);
							break;
					}
					continue;
				}

				let ref: PathRef = path;
				const existing = ids.get(key);
				if (existing !== undefined) {
					ref = existing;
				} else if (seen.has(key)) {
					const id = nextId++;
					ids.set(key, id);
					out.push(["#", id, path]); // 第二次使用：先定义，再引用。
					ref = id;
				} else {
					seen.add(key); // 首次使用：内联展开。
				}

				switch (op[0]) {
					case "s":
						out.push(["s", ref as PathRef<NonEmptyPath>, op[2]]);
						break;
					case "d":
						out.push(["d", ref as PathRef<NonEmptyPath>]);
						break;
					case "a":
						out.push(["a", ref as PathRef<NonEmptyPath>, op[2]]);
						break;
					case "t":
						out.push(["t", ref as PathRef<NonEmptyPath>, op[2]]);
						break;
					case "p":
						out.push(["p", ref, op[2], op[3], op[4]]);
						break;
					case "m":
						out.push(["m", ref, op[2]]);
						break;
				}
				previous = key;
			}
			return out;
		},
	};
}

export interface Decoder {
	decode(wire: readonly WireOp[]): Op[];
}

export function decoder(): Decoder {
	const paths = new Map<number, Path>();

	return {
		decode(wire) {
			let previous: Path | undefined; // 与 encode 相同，previous 仅在当前批次内有效。
			const out: Op[] = [];
			for (const op of wire) {
				assertValidWireOp(op);
				if (op[0] === "#") {
					assertSafePath(op[2]);
					paths.set(op[1], op[2]);
					continue;
				}
				if (op[0] === "r") {
					out.push(op);
					paths.clear();
					previous = undefined;
					continue;
				}

				// 根据元组长度判断是否包含路径引用：简写形式会省略该引用。
				const short =
					(op[0] === "d" && op.length === 1) ||
					(op[0] !== "d" && op[0] !== "p" && op.length === 2) ||
					(op[0] === "p" && op.length === 4);

				let path: Path;
				if (short) {
					if (previous === undefined) throw new PathError([]);
					path = previous;
				} else {
					const ref = op[1] as PathRef;
					if (typeof ref === "number") {
						const resolved = paths.get(ref);
						if (resolved === undefined) throw new PathError(ref);
						path = resolved;
					} else {
						path = ref;
					}
					previous = path;
				}

				if (op[0] !== "p" && op[0] !== "m" && path.length === 0) throw new PathError(path);
				switch (op[0]) {
					case "s":
						out.push(["s", path as NonEmptyPath, (short ? op[1] : op[2]) as JsonValue]);
						break;
					case "d":
						out.push(["d", path as NonEmptyPath]);
						break;
					case "a":
						out.push(["a", path as NonEmptyPath, (short ? op[1] : op[2]) as string]);
						break;
					case "t":
						out.push(["t", path as NonEmptyPath, (short ? op[1] : op[2]) as number]);
						break;
					case "p": {
						const [i, r, items] = short
							? [op[1] as number, op[2] as number, op[3] as JsonValue[]]
							: [op[2] as number, op[3] as number, op[4] as JsonValue[]];
						out.push(["p", path, i, r, items]);
						break;
					}
					case "m":
						out.push(["m", path, (short ? op[1] : op[2]) as number[]]);
						break;
				}
			}
			return out;
		},
	};
}
