import { IMAGE_MODELS } from "./models.generated.ts";
import type { ImageApi, ImageModel } from "./types.ts";

/**
 * 兼容层对生成目录的读取，仅限于图像模型。新代码应使用
 * `Models.getModelOfType("image", ...)` 或 `providers/all` 中的 `getBuiltinImageModel()`。
 */

type Catalog = typeof IMAGE_MODELS;
type ImageModelIds<TProvider extends keyof Catalog> = keyof Catalog[TProvider];

/** 在生成目录中至少有一个图像模型的内置 provider。 */
export type BuiltinImageProvider = {
	[TProvider in keyof Catalog]: [ImageModelIds<TProvider>] extends [never] ? never : TProvider;
}[keyof Catalog];

type BuiltinImageModel<
	TProvider extends BuiltinImageProvider,
	TModelId extends ImageModelIds<TProvider>,
> = Catalog[TProvider][TModelId] extends ImageModel<infer TApi extends ImageApi> ? ImageModel<TApi> : never;

const imageModelsByProvider = new Map<string, Map<string, ImageModel<ImageApi>>>();
for (const [provider, models] of Object.entries(IMAGE_MODELS)) {
	const imageModels = new Map<string, ImageModel<ImageApi>>();
	for (const model of Object.values(models as Record<string, ImageModel<ImageApi>>)) {
		imageModels.set(model.id, model);
	}
	if (imageModels.size > 0) imageModelsByProvider.set(provider, imageModels);
}

/** @deprecated 静态目录读取。请使用 "@earendil-works/pi-ai/providers/all" 中的 `getBuiltinImageModel` 或 `Models.getModelOfType("image", ...)`。 */
export function getImageModel<TProvider extends BuiltinImageProvider, TModelId extends ImageModelIds<TProvider>>(
	provider: TProvider,
	modelId: TModelId,
): BuiltinImageModel<TProvider, TModelId> {
	return imageModelsByProvider.get(provider)?.get(modelId as string) as BuiltinImageModel<TProvider, TModelId>;
}

/** @deprecated 静态目录读取。请使用 `Models.getProviders()`。 */
export function getImageProviders(): BuiltinImageProvider[] {
	return Array.from(imageModelsByProvider.keys()) as BuiltinImageProvider[];
}

/** @deprecated 静态目录读取。请使用 "@earendil-works/pi-ai/providers/all" 中的 `getBuiltinImageModels` 或 `Models.getModelsOfType("image")`。 */
export function getImageModels<TProvider extends BuiltinImageProvider>(
	provider: TProvider,
): BuiltinImageModel<TProvider, ImageModelIds<TProvider>>[] {
	const models = imageModelsByProvider.get(provider);
	return models ? (Array.from(models.values()) as BuiltinImageModel<TProvider, ImageModelIds<TProvider>>[]) : [];
}
