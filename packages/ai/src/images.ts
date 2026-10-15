import "./providers/images/register-builtins.ts";

import { getImagesApiProvider } from "./images-api-registry.ts";
import type { AssistantImages, ImageApi, ImageModel, ImagesContext, ProviderImagesOptions } from "./types.ts";

function resolveImagesApiProvider(api: ImageApi) {
	const provider = getImagesApiProvider(api);
	if (!provider) {
		throw new Error(`No API provider registered for api: ${api}`);
	}
	return provider;
}

/**
 * 全局图像生成，通过 images api 注册表按 `model.api` 分发。认证必须通过
 * `options.apiKey` 显式传入；优先使用会解析 provider 认证的
 * `Models.generateImages()`。
 */
export async function generateImages(
	model: ImageModel<ImageApi>,
	context: ImagesContext,
	options?: ProviderImagesOptions,
): Promise<AssistantImages> {
	const provider = resolveImagesApiProvider(model.api);
	return provider.generateImages(model, context, options);
}
