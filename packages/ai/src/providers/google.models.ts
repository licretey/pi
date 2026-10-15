// 此文件由 scripts/generate-models.ts 自动生成。
// 请勿手动编辑；运行 'npm run generate-models' 进行更新。

import values from "./data/google.json" with { type: "json" };
import { flattenChatModelCatalog, flattenClassifierModelCatalog, flattenImageModelCatalog, type ChatModelCatalog, type ClassifierModelCatalog, type ImageModelCatalog } from "../model-catalog.ts";

export const GOOGLE_MODELS: ChatModelCatalog<typeof values, "google"> =
	flattenChatModelCatalog("google", values);

export const GOOGLE_IMAGE_MODELS: ImageModelCatalog<typeof values, "google"> =
	flattenImageModelCatalog("google", values);

export const GOOGLE_CLASSIFIER_MODELS: ClassifierModelCatalog<typeof values, "google"> =
	flattenClassifierModelCatalog("google", values);
