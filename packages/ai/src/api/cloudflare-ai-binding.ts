/**
 * 基于 Workers AI binding 的 AI Gateway 传输层。
 *
 * pi 的 Cloudflare AI Gateway 支持走 HTTPS
 * (`gateway.ai.cloudflare.com/v1/{account}/{gateway}/{provider}/...`，见 `api/cloudflare.ts`)，
 * 即便调用方是 gateway 所在账号内的 Worker，也需要一个 Cloudflare API token。
 *
 * Worker 可以免掉这个 token：通过 AI binding 的 `fetch` 直通（`env.AI.fetch()`）与 gateway 通信，它在
 * `https://workers-binding.ai/ai-gateway/gateways/{gateway}/{provider}/{endpoint...}` 提供 gateway 的
 * provider 直通——与 HTTPS URL 同形，只是没有 account id（binding 通道自带身份）。绑定调用在账号内
 * 已预认证，并以普通（流式）`Response` 形式返回 provider 的原生线上格式，因此各 API 实现在两种传输下
 * 行为一致。
 *
 * 因此 `baseUrl` 指向该路由的模型无需任何转换：直接指过去，并把
 * {@link createAiBindingFetch} 作为请求的 `fetch` 传入。没有任何改写、缓冲或
 * 重新编码——method、headers、query string 与 body 流原样到达 binding，
 * 所以所有 method、非 JSON body 以及流式请求体都能工作。
 *
 * 本模块相对自己调用 `env.AI.fetch()` 增加的只是一个类型：`Ai#fetch`
 * 在运行时是存在的（`workerd/src/cloudflare/internal/ai-api.ts:158`），但
 * `@cloudflare/workers-types` 的 `Ai` 类尚未声明它，若直接调用就得在
 * 每个调用点做类型断言。{@link AiBinding} 代为承担该断言——把
 * `fetch` 声明为可选、在构造时检查一次——这样 `env.AI` 可以原样传入。等
 * workers-types 声明了 `fetch`，可选标记和运行时检查都会移除。
 */

import type { FetchFunction } from "../types.ts";

/**
 * Workers AI binding（`env.AI`），以结构化方式描述，使本模块不依赖
 * `@cloudflare/workers-types`。
 *
 * `fetch` 之所以可选，只是因为已发布的 `Ai` 类型尚未声明它——每个真实的
 * binding 在运行时都有它。`aiGatewayLogId` 在这里用于把类型钉死在 AI binding 上：它是
 * `Ai` 独有的成员，否则该接口也会接受 `AiGateway`
 * 或任何手写的 `{ fetch }` 对象，而那正是运行时检查本想避免、却拖到很晚才报错的问题。
 */
export interface AiBinding {
	aiGatewayLogId: string | null;
	fetch?(input: Request | string | URL, init?: RequestInit): Promise<Response>;
}

/**
 * 由 binding 承载的请求在 auth header 上使用的占位值。各 API 实现分发之前
 * 要求有 API key 或可识别的 auth header（`authorization`、`x-api-key`、
 * `cf-aig-authorization`）；binding 调用已预认证，因此传
 * `cf-aig-authorization: Bearer ${CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL}` 即可通过
 * 该检查。gateway 会忽略（并剥除）binding 承载请求上的
 * `cf-aig-authorization`。请搭配 `Authorization: null` / `x-api-key: null`，使 SDK 的占位
 * auth header 到不了 gateway——否则 gateway 会把请求自带的 auth header 当作
 * BYOK provider key，覆盖其存储的密钥——与走 HTTPS 时的行为相同。
 */
export const CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL = "cloudflare-gateway-binding";

/**
 * 创建一个由 AI binding 支撑的 `fetch`，适用于那些 `baseUrl` 已经指向 binding 提供服务的路由
 * 的模型——包括 gateway 的 provider 直通
 * `https://workers-binding.ai/ai-gateway/gateways/{gateway}/{provider}/...`。请求
 * 原样穿过。
 *
 * ```ts
 * const model = {
 *   // ...
 *   baseUrl: `https://workers-binding.ai/ai-gateway/gateways/${gateway}/anthropic`,
 * };
 * await models.complete(model, context, {
 *   headers: {
 *     "cf-aig-authorization": `Bearer ${CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL}`,
 *     Authorization: null,
 *     "x-api-key": null,
 *   },
 *   fetch: createAiBindingFetch(env.AI),
 * });
 * ```
 */
export function createAiBindingFetch(binding: AiBinding): FetchFunction {
	// `fetch` 在类型上是可选的，因此在此处提前检查它的存在，而不是等到
	// 第一次推理请求时才以令人费解的方式失败。
	if (typeof binding.fetch !== "function") {
		throw new TypeError("createAiBindingFetch: the AI binding does not expose fetch()");
	}
	// 立即绑定：`fetch` 是可变属性，上面的类型收窄不会延续到
	// 返回的闭包中。
	const bindingFetch = binding.fetch.bind(binding);
	return (input, init) => bindingFetch(input, init);
}
