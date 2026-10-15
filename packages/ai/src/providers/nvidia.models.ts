// 此文件由 scripts/generate-models.ts 自动生成。
// 请勿手动编辑；运行 'npm run generate-models' 进行更新。

import values from "./data/nvidia.json" with { type: "json" };
import { flattenChatModelCatalog, flattenClassifierModelCatalog, flattenImageModelCatalog, type ChatModelCatalog, type ClassifierModelCatalog, type ImageModelCatalog } from "../model-catalog.ts";

export const NVIDIA_MODELS: ChatModelCatalog<typeof values, "nvidia"> =
	flattenChatModelCatalog("nvidia", values);

export const NVIDIA_IMAGE_MODELS: ImageModelCatalog<typeof values, "nvidia"> =
	flattenImageModelCatalog("nvidia", values);

export const NVIDIA_CLASSIFIER_MODELS: ClassifierModelCatalog<typeof values, "nvidia"> =
	flattenClassifierModelCatalog("nvidia", values);
