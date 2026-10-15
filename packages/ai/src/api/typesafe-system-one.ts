import type { ClassifierFunction, ClassifierOptions } from "../types.ts";
import { isRecord } from "./classifier-shared.ts";
import { classifySystemOne, type SystemOneTransport } from "./system-one-shared.ts";

/**
 * TypeSafe 原生的 System One 协议。OpenRouter 也提供相同协议，
 * 因此两个提供商使用同一 API，只是基础 URL 不同。
 */
const transport: SystemOneTransport = {
	api: "typesafe-system-one",
	label: "System One API",
	url: (model) => new URL("systemone", `${model.baseUrl.replace(/\/+$/u, "")}/`),
	payload: (model, request) => ({ model: model.id, ...request }),
	output: (body) => {
		if (!isRecord(body)) throw new Error("System One API returned an unexpected response");
		return body;
	},
};

/** TypeSafe System One 分类接口：将公开的 `bool` 值映射为线上协议使用的 `noul`。 */
export const classify: ClassifierFunction<ClassifierOptions> = (model, context, options) =>
	classifySystemOne(transport, model, context, options);
