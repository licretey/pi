// 此文件由 scripts/generate-models.ts 自动生成。
// 请勿手动编辑；运行 'npm run generate-models' 进行更新。

import values from "./data/deepseek.json" with { type: "json" };
import { flattenChatModelCatalog, flattenClassifierModelCatalog, flattenImageModelCatalog, type ChatModelCatalog, type ClassifierModelCatalog, type ImageModelCatalog } from "../model-catalog.ts";

export const DEEPSEEK_MODELS: ChatModelCatalog<typeof values, "deepseek"> =
	flattenChatModelCatalog("deepseek", values);

export const DEEPSEEK_IMAGE_MODELS: ImageModelCatalog<typeof values, "deepseek"> =
	flattenImageModelCatalog("deepseek", values);

export const DEEPSEEK_CLASSIFIER_MODELS: ClassifierModelCatalog<typeof values, "deepseek"> =
	flattenClassifierModelCatalog("deepseek", values);
