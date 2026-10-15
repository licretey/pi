// 此文件由 scripts/generate-models.ts 自动生成。
// 请勿手动编辑；运行 'npm run generate-models' 进行更新。

import values from "./data/github-copilot.json" with { type: "json" };
import { flattenChatModelCatalog, flattenClassifierModelCatalog, flattenImageModelCatalog, type ChatModelCatalog, type ClassifierModelCatalog, type ImageModelCatalog } from "../model-catalog.ts";

export const GITHUB_COPILOT_MODELS: ChatModelCatalog<typeof values, "github-copilot"> =
	flattenChatModelCatalog("github-copilot", values);

export const GITHUB_COPILOT_IMAGE_MODELS: ImageModelCatalog<typeof values, "github-copilot"> =
	flattenImageModelCatalog("github-copilot", values);

export const GITHUB_COPILOT_CLASSIFIER_MODELS: ClassifierModelCatalog<typeof values, "github-copilot"> =
	flattenClassifierModelCatalog("github-copilot", values);
