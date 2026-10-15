// 此文件由 scripts/generate-models.ts 自动生成。
// 请勿手动编辑；运行 'npm run generate-models' 进行更新。

import values from "./data/google-vertex.json" with { type: "json" };
import { flattenChatModelCatalog, flattenClassifierModelCatalog, flattenImageModelCatalog, type ChatModelCatalog, type ClassifierModelCatalog, type ImageModelCatalog } from "../model-catalog.ts";

export const GOOGLE_VERTEX_MODELS: ChatModelCatalog<typeof values, "google-vertex"> =
	flattenChatModelCatalog("google-vertex", values);

export const GOOGLE_VERTEX_IMAGE_MODELS: ImageModelCatalog<typeof values, "google-vertex"> =
	flattenImageModelCatalog("google-vertex", values);

export const GOOGLE_VERTEX_CLASSIFIER_MODELS: ClassifierModelCatalog<typeof values, "google-vertex"> =
	flattenClassifierModelCatalog("google-vertex", values);
