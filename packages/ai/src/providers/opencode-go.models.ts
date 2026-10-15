// 此文件由 scripts/generate-models.ts 自动生成。
// 请勿手动编辑；运行 'npm run generate-models' 进行更新。

import values from "./data/opencode-go.json" with { type: "json" };
import { flattenChatModelCatalog, flattenClassifierModelCatalog, flattenImageModelCatalog, type ChatModelCatalog, type ClassifierModelCatalog, type ImageModelCatalog } from "../model-catalog.ts";

export const OPENCODE_GO_MODELS: ChatModelCatalog<typeof values, "opencode-go"> =
	flattenChatModelCatalog("opencode-go", values);

export const OPENCODE_GO_IMAGE_MODELS: ImageModelCatalog<typeof values, "opencode-go"> =
	flattenImageModelCatalog("opencode-go", values);

export const OPENCODE_GO_CLASSIFIER_MODELS: ClassifierModelCatalog<typeof values, "opencode-go"> =
	flattenClassifierModelCatalog("opencode-go", values);
