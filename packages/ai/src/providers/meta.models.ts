// 此文件由 scripts/generate-models.ts 自动生成。
// 请勿手动编辑；运行 'npm run generate-models' 进行更新。

import values from "./data/meta.json" with { type: "json" };
import { flattenChatModelCatalog, flattenClassifierModelCatalog, flattenImageModelCatalog, type ChatModelCatalog, type ClassifierModelCatalog, type ImageModelCatalog } from "../model-catalog.ts";

export const META_MODELS: ChatModelCatalog<typeof values, "meta"> =
	flattenChatModelCatalog("meta", values);

export const META_IMAGE_MODELS: ImageModelCatalog<typeof values, "meta"> =
	flattenImageModelCatalog("meta", values);

export const META_CLASSIFIER_MODELS: ClassifierModelCatalog<typeof values, "meta"> =
	flattenClassifierModelCatalog("meta", values);
