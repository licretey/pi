// 此文件由 scripts/generate-models.ts 自动生成。
// 请勿手动编辑；运行 'npm run generate-models' 进行更新。

import values from "./data/radius.json" with { type: "json" };
import { flattenChatModelCatalog, flattenClassifierModelCatalog, flattenImageModelCatalog, type ChatModelCatalog, type ClassifierModelCatalog, type ImageModelCatalog } from "../model-catalog.ts";

export const RADIUS_MODELS: ChatModelCatalog<typeof values, "radius"> =
	flattenChatModelCatalog("radius", values);

export const RADIUS_IMAGE_MODELS: ImageModelCatalog<typeof values, "radius"> =
	flattenImageModelCatalog("radius", values);

export const RADIUS_CLASSIFIER_MODELS: ClassifierModelCatalog<typeof values, "radius"> =
	flattenClassifierModelCatalog("radius", values);
