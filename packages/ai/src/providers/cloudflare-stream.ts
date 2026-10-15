import type { ProviderClassifier, ProviderEnv, ProviderStreams } from "../types.ts";

const CLOUDFLARE_ACCOUNT_ID = "CLOUDFLARE_ACCOUNT_ID";
const CLOUDFLARE_GATEWAY_ID = "CLOUDFLARE_GATEWAY_ID";

export function resolveCloudflareModel<TModel extends { baseUrl: string }>(
	model: TModel,
	env: ProviderEnv | undefined,
): TModel {
	if (!env) return model;
	const baseUrl = model.baseUrl
		.replaceAll(`{${CLOUDFLARE_ACCOUNT_ID}}`, env[CLOUDFLARE_ACCOUNT_ID] ?? `{${CLOUDFLARE_ACCOUNT_ID}}`)
		.replaceAll(`{${CLOUDFLARE_GATEWAY_ID}}`, env[CLOUDFLARE_GATEWAY_ID] ?? `{${CLOUDFLARE_GATEWAY_ID}}`);
	return baseUrl === model.baseUrl ? model : { ...model, baseUrl };
}

/**
 * 包装 API 实现，使 Cloudflare account/gateway 端点占位符在分发前
 * 从解析出的提供商 env 中填充为真实值。
 */
export function cloudflareStreams(streams: ProviderStreams): ProviderStreams {
	return {
		stream: (model, context, options) =>
			streams.stream(resolveCloudflareModel(model, options?.env), context, options),
		streamSimple: (model, context, options) =>
			streams.streamSimple(resolveCloudflareModel(model, options?.env), context, options),
	};
}

/** {@link cloudflareStreams} 的分类器对应版本。 */
export function cloudflareClassifier(classifier: ProviderClassifier): ProviderClassifier {
	return {
		classify: (model, context, options) =>
			classifier.classify(resolveCloudflareModel(model, options?.env), context, options),
	};
}
