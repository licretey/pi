// 此文件由 scripts/generate-models.ts 自动生成。
// 请勿手动编辑；运行 'npm run generate-models' 进行更新。

import values from "./data/qwen-token-plan-individual.json" with { type: "json" };
import { flattenChatModelCatalog, flattenClassifierModelCatalog, flattenImageModelCatalog, type ChatModelCatalog, type ClassifierModelCatalog, type ImageModelCatalog } from "../model-catalog.ts";

export const QWEN_TOKEN_PLAN_INDIVIDUAL_MODELS: ChatModelCatalog<typeof values, "qwen-token-plan-individual"> =
	flattenChatModelCatalog("qwen-token-plan-individual", values);

export const QWEN_TOKEN_PLAN_INDIVIDUAL_IMAGE_MODELS: ImageModelCatalog<typeof values, "qwen-token-plan-individual"> =
	flattenImageModelCatalog("qwen-token-plan-individual", values);

export const QWEN_TOKEN_PLAN_INDIVIDUAL_CLASSIFIER_MODELS: ClassifierModelCatalog<typeof values, "qwen-token-plan-individual"> =
	flattenClassifierModelCatalog("qwen-token-plan-individual", values);
