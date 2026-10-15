// 此文件由 scripts/generate-models.ts 自动生成。
// 请勿手动编辑；运行 'npm run generate-models' 进行更新。

import values from "./data/opencode.json" with { type: "json" };
import { flattenChatModelCatalog, flattenClassifierModelCatalog, flattenImageModelCatalog, type ChatModelCatalog, type ClassifierModelCatalog, type ImageModelCatalog } from "../model-catalog.ts";

export const OPENCODE_MODELS: ChatModelCatalog<typeof values, "opencode"> =
	flattenChatModelCatalog("opencode", values);

export const OPENCODE_IMAGE_MODELS: ImageModelCatalog<typeof values, "opencode"> =
	flattenImageModelCatalog("opencode", values);

export const OPENCODE_CLASSIFIER_MODELS: ClassifierModelCatalog<typeof values, "opencode"> =
	flattenClassifierModelCatalog("opencode", values);
