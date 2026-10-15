// 此文件由 scripts/generate-models.ts 自动生成。
// 请勿手动编辑；运行 'npm run generate-models' 进行更新。

import values from "./data/openrouter.json" with { type: "json" };
import { flattenChatModelCatalog, flattenClassifierModelCatalog, flattenImageModelCatalog, type ChatModelCatalog, type ClassifierModelCatalog, type ImageModelCatalog } from "../model-catalog.ts";

export const OPENROUTER_MODELS: ChatModelCatalog<typeof values, "openrouter"> =
	flattenChatModelCatalog("openrouter", values);

export const OPENROUTER_IMAGE_MODELS: ImageModelCatalog<typeof values, "openrouter"> =
	flattenImageModelCatalog("openrouter", values);

export const OPENROUTER_CLASSIFIER_MODELS: ClassifierModelCatalog<typeof values, "openrouter"> =
	flattenClassifierModelCatalog("openrouter", values);
