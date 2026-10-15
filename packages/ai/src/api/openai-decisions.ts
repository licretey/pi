import type {
	ClassifierAnswer,
	ClassifierContext,
	ClassifierFunction,
	ClassifierOptions,
	ClassifierQuestion,
	ClassifierResult,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import {
	type ClassifierHttpError,
	isRecord,
	parseClassifierUsage,
	postClassifierRequest,
	requiredNumber,
} from "./classifier-shared.ts";

/**
 * OpenAI Decisions API：向 `/v1/decisions` 发送包含 `{ model, input, questions }` 的 POST 请求。
 * https://developers.openai.com/api/docs/guides/decisions
 *
 * 状态以 JSON 文本发送。包含图像时，输入会变成一条用户消息：先以 `input_text` 提供状态，再附加 `input_image` data URL。
 * 问题会映射为 Decisions 类型：
 * `choice` to `choice`, `score` to `score`, and `bool` to `predicate`. Predicates have no
 * criteria 字段，因此 true 和 false 的含义会附加到说明中。
 *
 * 仅支持 OpenAI API 密钥：“使用 ChatGPT 登录”token 会被此路由拒绝。
 */

const LABEL = "OpenAI Decisions";

/** 此端点的每个请求最多接受的图像部分数量。 */
const MAX_IMAGES = 128;

interface DecisionQuestion {
	type: "predicate" | "choice" | "score";
	name: string;
	instructions: string;
	choices?: Array<{ value: string; description?: string }>;
	levels?: Array<{ label: string }>;
}

function predicateInstructions(question: Extract<ClassifierQuestion, { type: "bool" }>): string {
	const meanings = [
		question.criteria.true ? `True means: ${question.criteria.true}` : "",
		question.criteria.false ? `False means: ${question.criteria.false}` : "",
	].filter(Boolean);
	return meanings.length > 0 ? `${question.instructions}\n\n${meanings.join("\n")}` : question.instructions;
}

function wireQuestion(name: string, question: ClassifierQuestion): DecisionQuestion {
	if (question.type === "choice") {
		return {
			type: "choice",
			name,
			instructions: question.instructions,
			choices: Object.entries(question.criteria).map(([value, description]) =>
				description ? { value, description } : { value },
			),
		};
	}
	if (question.type === "score") {
		return {
			type: "score",
			name,
			instructions: question.instructions,
			levels: question.criteria.map((label) => ({ label })),
		};
	}
	return { type: "predicate", name, instructions: predicateInstructions(question) };
}

function wireInput(context: ClassifierContext): unknown {
	const state = JSON.stringify(context.state);
	const images = context.images ?? [];
	if (images.length === 0) return state;
	if (images.length > MAX_IMAGES) {
		throw new Error(`${LABEL} accepts at most ${MAX_IMAGES} images, got ${images.length}`);
	}
	return [
		{
			role: "user",
			content: [
				{ type: "input_text", text: state },
				...images.map((image) => ({
					type: "input_image",
					image_url: `data:${image.mimeType};base64,${image.data}`,
				})),
			],
		},
	];
}

function choiceProbabilities(value: unknown, id: string): Record<string, number> {
	if (!Array.isArray(value)) throw new Error(`${LABEL} returned invalid probabilities for ${id}`);
	return Object.fromEntries(
		value.map((entry) => {
			if (!isRecord(entry) || typeof entry.value !== "string") {
				throw new Error(`${LABEL} returned invalid probabilities for ${id}`);
			}
			return [entry.value, requiredNumber(LABEL, entry.probability, `probability for ${id}.${entry.value}`)];
		}),
	);
}

function parseAnswer(id: string, question: ClassifierQuestion, answer: Record<string, unknown>): ClassifierAnswer {
	if (answer.type === "refusal") throw new Error(`${LABEL} refused to answer ${id}`);
	if (question.type === "choice") {
		if (answer.type !== "choice" || typeof answer.choice !== "string") {
			throw new Error(`${LABEL} did not return a choice answer for ${id}`);
		}
		return {
			type: "choice",
			choice: answer.choice,
			probabilities: choiceProbabilities(answer.probabilities, id),
			confidence: requiredNumber(LABEL, answer.confidence, `confidence for ${id}`),
		};
	}
	if (question.type === "score") {
		if (answer.type !== "score") throw new Error(`${LABEL} did not return a score answer for ${id}`);
		return {
			type: "score",
			score: requiredNumber(LABEL, answer.score, `score for ${id}`),
			confidence: requiredNumber(LABEL, answer.confidence, `confidence for ${id}`),
		};
	}
	if (answer.type !== "predicate") throw new Error(`${LABEL} did not return a predicate answer for ${id}`);
	return { type: "bool", probability: requiredNumber(LABEL, answer.probability, `probability for ${id}`) };
}

function parseAnswers(value: unknown, context: ClassifierContext): Record<string, ClassifierAnswer> {
	if (!Array.isArray(value)) throw new Error(`${LABEL} returned an unexpected response`);
	const byName = new Map<string, Record<string, unknown>>();
	for (const answer of value) {
		if (isRecord(answer) && typeof answer.name === "string") byName.set(answer.name, answer);
	}
	return Object.fromEntries(
		Object.entries(context.questions).map(([id, question]) => {
			const answer = byName.get(id);
			if (!answer) throw new Error(`${LABEL} did not return an answer for ${id}`);
			return [id, parseAnswer(id, question, answer)];
		}),
	);
}

/**
 * api.openai.com 前的 Cloudflare 在请求耗时约超过五秒时会返回 HTML 格式的 504 响应。
 * 较大的输入（目前约超过 60 万 token）会触发此限制；重试相同输入仍会遇到此问题，因此不重试 504。
 */
const NO_RETRY_STATUSES = [504];

function errorMessage(error: unknown): string {
	if ((error as Partial<ClassifierHttpError>).status === 504) {
		return `${LABEL} error (504): the request timed out at the gateway. Very large inputs (above roughly 600K tokens) currently exceed its time limit.`;
	}
	return formatProviderError(normalizeProviderError(error), `${LABEL} error`);
}

/** 通过 OpenAI Decisions API 执行分类。 */
export const classify: ClassifierFunction<ClassifierOptions> = async (model, context, options) => {
	const output: ClassifierResult = {
		api: model.api,
		provider: model.provider,
		model: model.id,
		answers: {},
		stopReason: "stop",
		timestamp: Date.now(),
	};

	try {
		if (model.api !== "openai-decisions") throw new Error(`Unsupported classifier API: ${model.api}`);
		const body = await postClassifierRequest(
			LABEL,
			new URL("decisions", `${model.baseUrl.replace(/\/+$/u, "")}/`),
			model,
			{
				model: model.id,
				input: wireInput(context),
				questions: Object.entries(context.questions).map(([id, question]) => wireQuestion(id, question)),
			},
			options,
			NO_RETRY_STATUSES,
		);
		if (!isRecord(body)) throw new Error(`${LABEL} returned an unexpected response`);
		// 在解析答案前设置：即使答案格式错误或被拒绝，该请求仍会计费。
		const usage = parseClassifierUsage(body.usage, model);
		if (usage) output.usage = usage;
		output.answers = parseAnswers(body.answers, context);
		return output;
	} catch (error) {
		output.answers = {};
		output.stopReason = options?.signal?.aborted ? "aborted" : "error";
		output.errorMessage = errorMessage(error);
		return output;
	}
};
