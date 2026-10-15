// 此文件由 scripts/generate-models.ts 自动生成。
// 请勿手动编辑；运行 'npm run generate-models' 进行更新。

import values from "./data/xiaomi.json" with { type: "json" };
import { flattenChatModelCatalog, flattenClassifierModelCatalog, flattenImageModelCatalog, type ChatModelCatalog, type ClassifierModelCatalog, type ImageModelCatalog } from "../model-catalog.ts";

export const XIAOMI_MODELS: ChatModelCatalog<typeof values, "xiaomi"> =
	flattenChatModelCatalog("xiaomi", values);

export const XIAOMI_IMAGE_MODELS: ImageModelCatalog<typeof values, "xiaomi"> =
	flattenImageModelCatalog("xiaomi", values);

export const XIAOMI_CLASSIFIER_MODELS: ClassifierModelCatalog<typeof values, "xiaomi"> =
	flattenClassifierModelCatalog("xiaomi", values);
