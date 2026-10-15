// 此文件由 scripts/generate-models.ts 自动生成。
// 请勿手动编辑；运行 'npm run generate-models' 进行更新。

import values from "./data/fireworks.json" with { type: "json" };
import { flattenChatModelCatalog, flattenClassifierModelCatalog, flattenImageModelCatalog, type ChatModelCatalog, type ClassifierModelCatalog, type ImageModelCatalog } from "../model-catalog.ts";

export const FIREWORKS_MODELS: ChatModelCatalog<typeof values, "fireworks"> =
	flattenChatModelCatalog("fireworks", values);

export const FIREWORKS_IMAGE_MODELS: ImageModelCatalog<typeof values, "fireworks"> =
	flattenImageModelCatalog("fireworks", values);

export const FIREWORKS_CLASSIFIER_MODELS: ClassifierModelCatalog<typeof values, "fireworks"> =
	flattenClassifierModelCatalog("fireworks", values);
