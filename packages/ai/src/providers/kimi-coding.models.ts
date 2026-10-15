// 此文件由 scripts/generate-models.ts 自动生成。
// 请勿手动编辑；运行 'npm run generate-models' 进行更新。

import values from "./data/kimi-coding.json" with { type: "json" };
import { flattenChatModelCatalog, flattenClassifierModelCatalog, flattenImageModelCatalog, type ChatModelCatalog, type ClassifierModelCatalog, type ImageModelCatalog } from "../model-catalog.ts";

export const KIMI_CODING_MODELS: ChatModelCatalog<typeof values, "kimi-coding"> =
	flattenChatModelCatalog("kimi-coding", values);

export const KIMI_CODING_IMAGE_MODELS: ImageModelCatalog<typeof values, "kimi-coding"> =
	flattenImageModelCatalog("kimi-coding", values);

export const KIMI_CODING_CLASSIFIER_MODELS: ClassifierModelCatalog<typeof values, "kimi-coding"> =
	flattenClassifierModelCatalog("kimi-coding", values);
