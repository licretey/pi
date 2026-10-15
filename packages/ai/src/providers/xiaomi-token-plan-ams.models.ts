// 此文件由 scripts/generate-models.ts 自动生成。
// 请勿手动编辑；运行 'npm run generate-models' 进行更新。

import values from "./data/xiaomi-token-plan-ams.json" with { type: "json" };
import { flattenChatModelCatalog, flattenClassifierModelCatalog, flattenImageModelCatalog, type ChatModelCatalog, type ClassifierModelCatalog, type ImageModelCatalog } from "../model-catalog.ts";

export const XIAOMI_TOKEN_PLAN_AMS_MODELS: ChatModelCatalog<typeof values, "xiaomi-token-plan-ams"> =
	flattenChatModelCatalog("xiaomi-token-plan-ams", values);

export const XIAOMI_TOKEN_PLAN_AMS_IMAGE_MODELS: ImageModelCatalog<typeof values, "xiaomi-token-plan-ams"> =
	flattenImageModelCatalog("xiaomi-token-plan-ams", values);

export const XIAOMI_TOKEN_PLAN_AMS_CLASSIFIER_MODELS: ClassifierModelCatalog<typeof values, "xiaomi-token-plan-ams"> =
	flattenClassifierModelCatalog("xiaomi-token-plan-ams", values);
