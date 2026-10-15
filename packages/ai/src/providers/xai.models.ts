// 此文件由 scripts/generate-models.ts 自动生成。
// 请勿手动编辑；运行 'npm run generate-models' 进行更新。

import values from "./data/xai.json" with { type: "json" };
import { flattenChatModelCatalog, flattenClassifierModelCatalog, flattenImageModelCatalog, type ChatModelCatalog, type ClassifierModelCatalog, type ImageModelCatalog } from "../model-catalog.ts";

export const XAI_MODELS: ChatModelCatalog<typeof values, "xai"> =
	flattenChatModelCatalog("xai", values);

export const XAI_IMAGE_MODELS: ImageModelCatalog<typeof values, "xai"> =
	flattenImageModelCatalog("xai", values);

export const XAI_CLASSIFIER_MODELS: ClassifierModelCatalog<typeof values, "xai"> =
	flattenClassifierModelCatalog("xai", values);
