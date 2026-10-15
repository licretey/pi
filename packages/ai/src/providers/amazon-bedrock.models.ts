// 此文件由 scripts/generate-models.ts 自动生成。
// 请勿手动编辑；运行 'npm run generate-models' 进行更新。

import values from "./data/amazon-bedrock.json" with { type: "json" };
import { flattenChatModelCatalog, flattenClassifierModelCatalog, flattenImageModelCatalog, type ChatModelCatalog, type ClassifierModelCatalog, type ImageModelCatalog } from "../model-catalog.ts";

export const AMAZON_BEDROCK_MODELS: ChatModelCatalog<typeof values, "amazon-bedrock"> =
	flattenChatModelCatalog("amazon-bedrock", values);

export const AMAZON_BEDROCK_IMAGE_MODELS: ImageModelCatalog<typeof values, "amazon-bedrock"> =
	flattenImageModelCatalog("amazon-bedrock", values);

export const AMAZON_BEDROCK_CLASSIFIER_MODELS: ClassifierModelCatalog<typeof values, "amazon-bedrock"> =
	flattenClassifierModelCatalog("amazon-bedrock", values);
