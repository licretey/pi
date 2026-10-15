// 此文件由 scripts/generate-models.ts 自动生成。
// 请勿手动编辑；运行 'npm run generate-models' 进行更新。

import values from "./data/moonshotai.json" with { type: "json" };
import { flattenChatModelCatalog, flattenClassifierModelCatalog, flattenImageModelCatalog, type ChatModelCatalog, type ClassifierModelCatalog, type ImageModelCatalog } from "../model-catalog.ts";

export const MOONSHOTAI_MODELS: ChatModelCatalog<typeof values, "moonshotai"> =
	flattenChatModelCatalog("moonshotai", values);

export const MOONSHOTAI_IMAGE_MODELS: ImageModelCatalog<typeof values, "moonshotai"> =
	flattenImageModelCatalog("moonshotai", values);

export const MOONSHOTAI_CLASSIFIER_MODELS: ClassifierModelCatalog<typeof values, "moonshotai"> =
	flattenClassifierModelCatalog("moonshotai", values);
