// 此文件由 scripts/generate-models.ts 自动生成。
// 请勿手动编辑；运行 'npm run generate-models' 进行更新。

import values from "./data/mistral.json" with { type: "json" };
import { flattenChatModelCatalog, flattenClassifierModelCatalog, flattenImageModelCatalog, type ChatModelCatalog, type ClassifierModelCatalog, type ImageModelCatalog } from "../model-catalog.ts";

export const MISTRAL_MODELS: ChatModelCatalog<typeof values, "mistral"> =
	flattenChatModelCatalog("mistral", values);

export const MISTRAL_IMAGE_MODELS: ImageModelCatalog<typeof values, "mistral"> =
	flattenImageModelCatalog("mistral", values);

export const MISTRAL_CLASSIFIER_MODELS: ClassifierModelCatalog<typeof values, "mistral"> =
	flattenClassifierModelCatalog("mistral", values);
