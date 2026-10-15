// 此文件由 scripts/generate-models.ts 自动生成。
// 请勿手动编辑；运行 'npm run generate-models' 进行更新。

import values from "./data/zai.json" with { type: "json" };
import { flattenChatModelCatalog, flattenClassifierModelCatalog, flattenImageModelCatalog, type ChatModelCatalog, type ClassifierModelCatalog, type ImageModelCatalog } from "../model-catalog.ts";

export const ZAI_MODELS: ChatModelCatalog<typeof values, "zai"> =
	flattenChatModelCatalog("zai", values);

export const ZAI_IMAGE_MODELS: ImageModelCatalog<typeof values, "zai"> =
	flattenImageModelCatalog("zai", values);

export const ZAI_CLASSIFIER_MODELS: ClassifierModelCatalog<typeof values, "zai"> =
	flattenClassifierModelCatalog("zai", values);
