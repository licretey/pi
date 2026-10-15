// 此文件由 scripts/generate-models.ts 自动生成。
// 请勿手动编辑；运行 'npm run generate-models' 进行更新。

import values from "./data/qwen-token-plan-cn.json" with { type: "json" };
import { flattenChatModelCatalog, flattenClassifierModelCatalog, flattenImageModelCatalog, type ChatModelCatalog, type ClassifierModelCatalog, type ImageModelCatalog } from "../model-catalog.ts";

export const QWEN_TOKEN_PLAN_CN_MODELS: ChatModelCatalog<typeof values, "qwen-token-plan-cn"> =
	flattenChatModelCatalog("qwen-token-plan-cn", values);

export const QWEN_TOKEN_PLAN_CN_IMAGE_MODELS: ImageModelCatalog<typeof values, "qwen-token-plan-cn"> =
	flattenImageModelCatalog("qwen-token-plan-cn", values);

export const QWEN_TOKEN_PLAN_CN_CLASSIFIER_MODELS: ClassifierModelCatalog<typeof values, "qwen-token-plan-cn"> =
	flattenClassifierModelCatalog("qwen-token-plan-cn", values);
