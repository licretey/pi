// 此文件由 scripts/generate-models.ts 自动生成。
// 请勿手动编辑；运行 'npm run generate-models' 进行更新。

import values from "./data/typesafe.json" with { type: "json" };
import { flattenChatModelCatalog, flattenClassifierModelCatalog, flattenImageModelCatalog, type ChatModelCatalog, type ClassifierModelCatalog, type ImageModelCatalog } from "../model-catalog.ts";

export const TYPESAFE_MODELS: ChatModelCatalog<typeof values, "typesafe"> =
	flattenChatModelCatalog("typesafe", values);

export const TYPESAFE_IMAGE_MODELS: ImageModelCatalog<typeof values, "typesafe"> =
	flattenImageModelCatalog("typesafe", values);

export const TYPESAFE_CLASSIFIER_MODELS: ClassifierModelCatalog<typeof values, "typesafe"> =
	flattenClassifierModelCatalog("typesafe", values);
