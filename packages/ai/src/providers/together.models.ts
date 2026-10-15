// 此文件由 scripts/generate-models.ts 自动生成。
// 请勿手动编辑；运行 'npm run generate-models' 进行更新。

import values from "./data/together.json" with { type: "json" };
import { flattenChatModelCatalog, flattenClassifierModelCatalog, flattenImageModelCatalog, type ChatModelCatalog, type ClassifierModelCatalog, type ImageModelCatalog } from "../model-catalog.ts";

export const TOGETHER_MODELS: ChatModelCatalog<typeof values, "together"> =
	flattenChatModelCatalog("together", values);

export const TOGETHER_IMAGE_MODELS: ImageModelCatalog<typeof values, "together"> =
	flattenImageModelCatalog("together", values);

export const TOGETHER_CLASSIFIER_MODELS: ClassifierModelCatalog<typeof values, "together"> =
	flattenClassifierModelCatalog("together", values);
