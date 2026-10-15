// 此文件由 scripts/generate-models.ts 自动生成。
// 请勿手动编辑；运行 'npm run generate-models' 进行更新。

import values from "./data/ant-ling.json" with { type: "json" };
import { flattenChatModelCatalog, flattenClassifierModelCatalog, flattenImageModelCatalog, type ChatModelCatalog, type ClassifierModelCatalog, type ImageModelCatalog } from "../model-catalog.ts";

export const ANT_LING_MODELS: ChatModelCatalog<typeof values, "ant-ling"> =
	flattenChatModelCatalog("ant-ling", values);

export const ANT_LING_IMAGE_MODELS: ImageModelCatalog<typeof values, "ant-ling"> =
	flattenImageModelCatalog("ant-ling", values);

export const ANT_LING_CLASSIFIER_MODELS: ClassifierModelCatalog<typeof values, "ant-ling"> =
	flattenClassifierModelCatalog("ant-ling", values);
