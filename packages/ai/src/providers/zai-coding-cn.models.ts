// 此文件由 scripts/generate-models.ts 自动生成。
// 请勿手动编辑；运行 'npm run generate-models' 进行更新。

import values from "./data/zai-coding-cn.json" with { type: "json" };
import { flattenChatModelCatalog, flattenClassifierModelCatalog, flattenImageModelCatalog, type ChatModelCatalog, type ClassifierModelCatalog, type ImageModelCatalog } from "../model-catalog.ts";

export const ZAI_CODING_CN_MODELS: ChatModelCatalog<typeof values, "zai-coding-cn"> =
	flattenChatModelCatalog("zai-coding-cn", values);

export const ZAI_CODING_CN_IMAGE_MODELS: ImageModelCatalog<typeof values, "zai-coding-cn"> =
	flattenImageModelCatalog("zai-coding-cn", values);

export const ZAI_CODING_CN_CLASSIFIER_MODELS: ClassifierModelCatalog<typeof values, "zai-coding-cn"> =
	flattenClassifierModelCatalog("zai-coding-cn", values);
