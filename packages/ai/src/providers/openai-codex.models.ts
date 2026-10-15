// 此文件由 scripts/generate-models.ts 自动生成。
// 请勿手动编辑；运行 'npm run generate-models' 进行更新。

import values from "./data/openai-codex.json" with { type: "json" };
import { flattenChatModelCatalog, flattenClassifierModelCatalog, flattenImageModelCatalog, type ChatModelCatalog, type ClassifierModelCatalog, type ImageModelCatalog } from "../model-catalog.ts";

export const OPENAI_CODEX_MODELS: ChatModelCatalog<typeof values, "openai-codex"> =
	flattenChatModelCatalog("openai-codex", values);

export const OPENAI_CODEX_IMAGE_MODELS: ImageModelCatalog<typeof values, "openai-codex"> =
	flattenImageModelCatalog("openai-codex", values);

export const OPENAI_CODEX_CLASSIFIER_MODELS: ClassifierModelCatalog<typeof values, "openai-codex"> =
	flattenClassifierModelCatalog("openai-codex", values);
