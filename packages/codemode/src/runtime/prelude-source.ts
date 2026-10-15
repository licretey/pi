/**
 * 在脚本运行之前、于 QuickJS VM 内求值的 JavaScript。
 *
 * 该 VM 是独立的 wasm 实例，因此这里的一切都不需要守护 realm 边界。
 * prelude 将 host bridge 封装在闭包里，让脚本无法直接调用它，并以此为基础
 * 构建 `tools`、`ALL_TOOLS`、输出辅助函数（`text`、`image`、
 * `exit`、`console`）和 globals。工具参数与结果以 JSON 字符串的形式跨越
 * 边界，并在这一侧解析。
 *
 * 输出辅助函数：`text(value)` 追加一个文本项（非字符串会做
 * JSON 序列化），`image(urlOrItem)` 从 base64 `data:` URL、
 * `{ image_url }` 对象或 MCP `ImageContent` block 追加一张图片，`exit()` 成功结束
 * 脚本。`console.*` 追加标记为 console 输出的文本项。
 *
 * `store(key, value)` 与 `load(key)` 是同步的：它们作用于以 `storeJson` 传入的
 * JSON 文本快照，脚本写入的键会随一次成功的 "done" 一并上报。
 *
 * 求值结果是一个函数 `(bridge, toolsJson, globalsJson, storeJson) => { settle, run, stalled }`。
 * `toolsJson` 列出 `{ name, jsName, description }`：`tools[jsName]` 与 `tools[name]` 调用
 * 工具，`ALL_TOOLS` 列出 `{ name: jsName, description }`。
 * `stalled()` 上报一个未结束且没有 host 调用挂起的脚本：VM 内没有 timer 或 I/O，
 * 什么都不可能再唤醒它。
 * `globalsJson` 列出 `{ name, spread }`；`a.b` 形式的名称会被归组到一个冻结的 `a` 对象中。
 * `bridge(kind, a, b, c)` 的 kind 为 "call" 或 "global"（id, name, argsJson），
 * "output"（"text" 或 "console"，text）或（"image"，data，mimeType），或 "done"（ok，valueJsonOrErrorJson，writesJson）。
 *
 * 在其他一切之前，prelude 会冻结 built-in 并把内置 globals 变为只读。
 * prelude 与脚本共享它们，否则修补了某个内置对象的脚本（例如
 * `Array.prototype.toJSON`）可能破坏 prelude 上报给 host 的内容。
 */
export const MAX_STORE_VALUE_CHARS = 256 * 1024;
export const MAX_STORE_TOTAL_CHARS = 1024 * 1024;
/**
 * 一个脚本通过 `text()`、`image()` 和 `console.*` 能产生的输出上限：文本与 base64
 * 图片数据的字符数，以及条目数。host 会保留全部输出直到脚本结束，因此若不加
 * 限制，循环打印的脚本会把 host 内存撑到崩溃。条目数上限
 * 覆盖了打印空字符串的循环。
 */
export const MAX_OUTPUT_CHARS = 16 * 1024 * 1024;
export const MAX_OUTPUT_ITEMS = 100_000;

const IMAGE_HELPER_EXPECTS =
	"image expects a non-empty image URL string, an object with image_url, or a raw MCP image block";

export const PRELUDE_SOURCE: string = `(function (bridge, toolsJson, globalsJson, storeJson) {
	"use strict";

	// 冻结从内置 globals 可达的每个对象，外加只能从实例
	// 可达的 intrinsic（iterator 与 generator 原型、%TypedArray%）。
	//
	// 只靠冻结会通过 "override mistake" 破坏普通代码：原型上一个只读的数据属性在
	// 实例上同样不可赋值，因此 Error 子类中的 this.name = "MyError" 会抛错。常见的
	// 被覆盖属性会改用 accessor——其 setter 在实例上定义自有属性。
	(function lockdown() {
		const OVERRIDABLE = new Set(["constructor", "name", "message", "toString", "toLocaleString", "valueOf", "toJSON"]);
		const seen = new Set([globalThis]);
		const queue = [];
		const add = (value) => {
			if ((typeof value === "object" && value !== null) || typeof value === "function") {
				if (!seen.has(value)) {
					seen.add(value);
					queue.push(value);
				}
			}
		};

		// 对象字面量的 accessor 没有自己的 prototype 对象，函数表达式则不然——
		// 否则后者的 prototype.constructor 会被无休止地再次转换。
		function allowOverride(object, key, value, enumerable) {
			const { get, set } = Object.getOwnPropertyDescriptor(
				{
					get accessor() {
						return value;
					},
					set accessor(next) {
						if (this === object) {
							throw new TypeError("Cannot assign to read only property '" + String(key) + "' of a built-in");
						}
						if ((typeof this !== "object" || this === null) && typeof this !== "function") return;
						Object.defineProperty(this, key, { value: next, writable: true, enumerable: true, configurable: true });
					},
				},
				"accessor",
			);
			Object.defineProperty(object, key, { get, set, enumerable, configurable: false });
			add(get);
			add(set);
		}

		for (const key of Reflect.ownKeys(globalThis)) {
			const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
			add(descriptor.value);
			add(descriptor.get);
			add(descriptor.set);
			if ("value" in descriptor && descriptor.configurable) {
				Object.defineProperty(globalThis, key, { writable: false, configurable: false });
			}
		}
		add(Object.getPrototypeOf(function* () {}));
		add(Object.getPrototypeOf(async function () {}));
		add(Object.getPrototypeOf(async function* () {}));
		add(Object.getPrototypeOf(Int8Array));
		add(Object.getPrototypeOf([][Symbol.iterator]()));
		add(Object.getPrototypeOf(new Map()[Symbol.iterator]()));
		add(Object.getPrototypeOf(new Set()[Symbol.iterator]()));
		add(Object.getPrototypeOf(""[Symbol.iterator]()));
		add(Object.getPrototypeOf(/a/[Symbol.matchAll]("")));
		if (typeof Iterator === "function") {
			if (typeof Iterator.prototype.map === "function") add(Object.getPrototypeOf([].values().map((x) => x)));
			if (typeof Iterator.from === "function") add(Object.getPrototypeOf(Iterator.from({ next() {} })));
		}

		while (queue.length > 0) {
			const object = queue.pop();
			add(Object.getPrototypeOf(object));
			const descriptors = Object.getOwnPropertyDescriptors(object);
			for (const key of Reflect.ownKeys(descriptors)) {
				const descriptor = descriptors[key];
				if ("value" in descriptor) {
					add(descriptor.value);
					if (
						descriptor.writable &&
						descriptor.configurable &&
						(object === Object.prototype || OVERRIDABLE.has(key))
					) {
						allowOverride(object, key, descriptor.value, descriptor.enumerable);
					}
				} else {
					add(descriptor.get);
					add(descriptor.set);
				}
			}
			Object.freeze(object);
		}
	})();
	const stringify = JSON.stringify;
	const parse = JSON.parse;
	const promiseThen = Promise.prototype.then;
	const ErrorCtor = Error;
	const TypeErrorCtor = TypeError;
	const RangeErrorCtor = RangeError;
	const pending = new Map();
	let nextId = 1;
	let finished = false;
	// 由 exit() 抛出，用于在脚本已报告成功之后展开（unwind）脚本。
	const EXIT = Object.freeze({});

	function done(ok, payload, writes) {
		if (finished) return;
		finished = true;
		bridge("done", ok, payload, writes);
	}

	function serialize(value) {
		return value === undefined ? undefined : stringify(value);
	}

	// QuickJS 的栈只列出帧。像 V8 一样加上 "Name: message" 前缀，让
	// 文本读起来与 Node 错误一致，并丢掉 prelude 自己的帧。
	function errorText(error) {
		const head = error.message ? error.name + ": " + error.message : String(error.name);
		const frames =
			typeof error.stack === "string"
				? error.stack.split("\\n").filter((line) => line.trim() && !line.includes("codemode-prelude.js"))
				: [];
		return [head, ...frames].join("\\n");
	}

	function format(value) {
		if (typeof value === "string") return value;
		if (value instanceof ErrorCtor) return errorText(value);
		try {
			const json = stringify(value);
			return json === undefined ? String(value) : json;
		} catch {
			return String(value);
		}
	}

	// host 需要字符串字段。脚本可以把错误的 name 或 message 设为任何值，因此这里
	// 做了强制转换；转换时抛错的值会得到占位符。
	function describeError(error) {
		try {
			if (error instanceof ErrorCtor) {
				return stringify({ name: String(error.name), message: String(error.message), stack: errorText(error) });
			}
			return stringify({ message: String(format(error)) });
		} catch {
			return stringify({ message: "The script threw a value that cannot be described" });
		}
	}

	function caller(kind, name, spread) {
		return (...args) =>
			new Promise((resolve, reject) => {
				let json;
				try {
					json = serialize(spread ? args : args[0]);
				} catch (error) {
					reject(error);
					return;
				}
				const id = nextId++;
				pending.set(id, { resolve, reject });
				bridge(kind, id, name, json);
			});
	}

	const tools = Object.create(null);
	const allTools = [];
	for (const { name, jsName, description } of parse(toolsJson)) {
		const fn = caller("call", name);
		// 两个名称规范化为同一标识符时，先出现的工具胜出。
		if (!(jsName in tools)) {
			tools[jsName] = fn;
			allTools.push(Object.freeze({ name: jsName, description }));
		}
		if (!(name in tools)) tools[name] = fn;
	}
	Object.freeze(tools);
	Object.freeze(allTools);

	// 读取不存在的成员时，抛出的错误会列出相近项，而不是稍后
	// 的 "not a function"。\`in\` 检查仍然可用。
	const comparable = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, "");
	function guard(target, label, names, hint) {
		return new Proxy(target, {
			get(object, property, receiver) {
				if (typeof property !== "string" || property in object || property in Object.prototype || property === "then" || property === "toJSON") {
					return Reflect.get(object, property, receiver);
				}
				const wanted = comparable(property);
				const exact = names.filter((name) => comparable(name) === wanted);
				const close = exact.length > 0 ? exact : names.filter((name) => wanted && (comparable(name).includes(wanted) || wanted.includes(comparable(name))));
				let message = label + "." + property + " does not exist.";
				if (close.length > 0) message += " Did you mean " + close.slice(0, 5).map((name) => label + "." + name).join(", ") + "?";
				else if (names.length <= 20) message += " Available: " + names.join(", ") + ".";
				if (hint) message += " " + hint;
				message += ' Check for a member with "' + property + '" in ' + label + ".";
				throw new TypeErrorCtor(message);
			},
		});
	}
	const toolsProxy = guard(
		tools,
		"tools",
		allTools.map((tool) => tool.name),
		"ALL_TOOLS lists every tool; searchTools(query) finds tools by topic.",
	);

	const namespaces = new Map();
	for (const { name, spread } of parse(globalsJson)) {
		const fn = caller("global", name, spread);
		const dot = name.indexOf(".");
		if (dot === -1) {
			Object.defineProperty(globalThis, name, { value: fn, enumerable: true });
			continue;
		}
		const namespace = name.slice(0, dot);
		if (!namespaces.has(namespace)) namespaces.set(namespace, Object.create(null));
		namespaces.get(namespace)[name.slice(dot + 1)] = fn;
	}
	for (const [namespace, members] of namespaces) {
		Object.freeze(members);
		const value = guard(members, namespace, Object.keys(members));
		Object.defineProperty(globalThis, namespace, { value, enumerable: true });
	}

	// key -> JSON 文本。大小统计 key 与 JSON 字符数。
	const stored = new Map(Object.entries(parse(storeJson)));
	const writes = new Map();
	let storedChars = 0;
	for (const [key, json] of stored) storedChars += key.length + json.length;

	const STORE_HINT =
		"store() is for small state such as IDs or summaries. Show images with image(), keep large data in variables, or write it to a file with a tool.";

	function checkKey(name, key) {
		if (typeof key !== "string") throw new TypeError(name + "() key must be a string");
	}

	function store(key, value) {
		checkKey("store", key);
		const previous = stored.has(key) ? key.length + stored.get(key).length : 0;
		if (value === undefined) {
			stored.delete(key);
			storedChars -= previous;
			writes.set(key, undefined);
			return;
		}
		let json;
		try {
			json = stringify(value);
		} catch (error) {
			throw new TypeError("store(" + stringify(key) + ") value is not JSON-serializable: " + format(error));
		}
		if (json === undefined) {
			throw new TypeError("store(" + stringify(key) + ") value is not JSON-serializable");
		}
		if (json.length > ${MAX_STORE_VALUE_CHARS}) {
			throw new RangeError(
				"store(" + stringify(key) + ") value has " + json.length + " characters of JSON, more than the limit of ${MAX_STORE_VALUE_CHARS}. " +
					STORE_HINT,
			);
		}
		const next = storedChars - previous + key.length + json.length;
		if (next > ${MAX_STORE_TOTAL_CHARS}) {
			throw new RangeError(
				"store is full: stored values would exceed ${MAX_STORE_TOTAL_CHARS} characters of JSON. Delete keys with store(key, undefined). " +
					STORE_HINT,
			);
		}
		stored.set(key, json);
		storedChars = next;
		writes.set(key, json);
	}

	function load(key) {
		checkKey("load", key);
		const json = stored.get(key);
		return json === undefined ? undefined : parse(json);
	}

	function serializeWrites() {
		const entries = [];
		for (const [key, json] of writes) entries.push(json === undefined ? [key] : [key, json]);
		return stringify(entries);
	}

	Object.defineProperty(globalThis, "store", { value: store, enumerable: true });
	Object.defineProperty(globalThis, "load", { value: load, enumerable: true });

	let outputChars = 0;
	let outputItems = 0;

	// 超出输出上限后脚本失败：done() 会报告错误，因此捕获它也无法
	// 恢复输出，host 会结束脚本。
	function output(kind, data, mimeType) {
		if (finished) return;
		outputChars += data.length;
		outputItems++;
		if (outputChars > ${MAX_OUTPUT_CHARS} || outputItems > ${MAX_OUTPUT_ITEMS}) {
			const error = new RangeErrorCtor(
				"script output exceeded the limit of ${MAX_OUTPUT_CHARS} characters or ${MAX_OUTPUT_ITEMS} text(), image(), and console calls. " +
					"Print a summary instead, or write large data to a file with a tool.",
			);
			done(false, describeError(error));
			throw error;
		}
		bridge("output", kind, data, mimeType);
	}

	// 基本类型转为其字符串形式，其余转 JSON。
	function outputText(value) {
		if (value === undefined || value === null || typeof value !== "object" && typeof value !== "function") {
			return String(value);
		}
		const json = stringify(value);
		return json === undefined ? String(value) : json;
	}

	function text(value) {
		let rendered;
		try {
			rendered = outputText(value);
		} catch (error) {
			throw new TypeErrorCtor(error instanceof ErrorCtor ? error.message : String(error));
		}
		output("text", rendered);
	}

	function imageUrl(value) {
		if (typeof value === "string") return value;
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			throw new TypeErrorCtor(${JSON.stringify(IMAGE_HELPER_EXPECTS)});
		}
		if (value.image_url !== undefined) {
			if (typeof value.image_url !== "string") throw new TypeErrorCtor(${JSON.stringify(IMAGE_HELPER_EXPECTS)});
			return value.image_url;
		}
		if (typeof value.type !== "string") throw new TypeErrorCtor(${JSON.stringify(IMAGE_HELPER_EXPECTS)});
		if (value.type !== "image") {
			throw new TypeErrorCtor('image only accepts MCP image blocks, got "' + value.type + '"');
		}
		if (typeof value.data !== "string" || value.data === "") throw new TypeErrorCtor("image expected MCP image data");
		if (value.data.toLowerCase().startsWith("data:")) return value.data;
		return "data:;base64," + value.data;
	}

	// 提供商支持内联的图片格式的签名 base64（PNG、JPEG（除
	// JPEG-LS 外）、GIF、"RIFF....WEBP"）。签名从字节 0 开始，因此它们的编码是前缀。
	const IMAGE_SIGNATURES = [
		["image/png", /^iVBORw0KGg/],
		["image/jpeg", /^[/]9j[/](?!9)/],
		["image/gif", /^R0lGOD[dl]h/],
		["image/webp", /^UklG.{8}RUJQ/],
	];

	function image(value) {
		const url = imageUrl(value);
		if (url === "") throw new TypeErrorCtor(${JSON.stringify(IMAGE_HELPER_EXPECTS)});
		const colon = url.indexOf(":");
		const scheme = colon === -1 ? "" : url.slice(0, colon).toLowerCase();
		if (scheme === "http" || scheme === "https") {
			throw new TypeErrorCtor("remote image URLs are not supported in tool outputs. Pass a base64 data URI instead");
		}
		const comma = url.indexOf(",");
		const header = comma === -1 ? [] : url.slice(colon + 1, comma).split(";");
		if (scheme !== "data" || comma === -1 || header.slice(1).every((part) => part.toLowerCase() !== "base64")) {
			throw new TypeErrorCtor("invalid image output. Pass a base64 data URI instead");
		}
		// 遇到坏图片时提供商会拒绝整个请求，而持久化的 image block 会在之后的每一轮
		// 重复发送。从换行包装的 base64 中删掉换行符。声明的类型被忽略，
		// 以检测出的类型为准——提供商同样拒绝不匹配的情况。
		const data = url.slice(comma + 1).replace(/\\s+/g, "");
		if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
			throw new TypeErrorCtor("invalid image output. The image data is not valid base64 (truncated or corrupted?)");
		}
		const head = data.slice(0, 16);
		const signature = IMAGE_SIGNATURES.find(([, pattern]) => pattern.test(head));
		if (!signature) {
			throw new TypeErrorCtor("invalid image output. The image data is not a PNG, JPEG, GIF, or WebP image");
		}
		output("image", data, signature[0]);
	}

	function exit() {
		let writesJson;
		try {
			writesJson = serializeWrites();
		} catch (error) {
			done(false, describeError(error));
			throw EXIT;
		}
		done(true, undefined, writesJson);
		throw EXIT;
	}

	const console = {};
	for (const level of ["log", "info", "warn", "error", "debug"]) {
		console[level] = (...args) => {
			output("console", args.map(format).join(" "));
		};
	}
	Object.freeze(console);

	Object.defineProperty(globalThis, "tools", { value: toolsProxy, enumerable: true });
	Object.defineProperty(globalThis, "ALL_TOOLS", { value: allTools, enumerable: true });
	Object.defineProperty(globalThis, "console", { value: console, enumerable: true });
	Object.defineProperty(globalThis, "text", { value: text, enumerable: true });
	Object.defineProperty(globalThis, "image", { value: image, enumerable: true });
	Object.defineProperty(globalThis, "exit", { value: exit, enumerable: true });

	return {
		settle(id, ok, payload) {
			const entry = pending.get(id);
			if (!entry) return;
			pending.delete(id);
			if (!ok) {
				entry.reject(new ErrorCtor(payload));
				return;
			}
			let value;
			try {
				value = payload === undefined ? undefined : parse(payload);
			} catch (error) {
				entry.reject(error);
				return;
			}
			entry.resolve(value);
		},
		run(fn) {
			let promise;
			try {
				promise = fn(toolsProxy, console);
			} catch (error) {
				done(false, describeError(error));
				return;
			}
			promiseThen.call(
				promise,
				(value) => {
					let json;
					try {
						json = serialize(value);
					} catch (error) {
						done(false, describeError(error));
						return;
					}
					done(true, json, serializeWrites());
				},
				(error) => {
					done(false, describeError(error));
				},
			);
		},
		stalled() {
			if (finished || pending.size > 0) return false;
			done(
				false,
				stringify({
					name: "Error",
					message:
						"The script is waiting on a promise that can never settle: no tool call is pending, and timers do not exist here.",
				}),
			);
			return true;
		},
	};
})`;
