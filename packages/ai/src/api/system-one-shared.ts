import type {
	ClassifierAnswer,
	ClassifierApi,
	ClassifierContext,
	ClassifierModel,
	ClassifierOptions,
	ClassifierResult,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { isRecord, parseClassifierUsage, postClassifierRequest, requiredNumber } from "./classifier-shared.ts";

/** 不含传输专属封装的 TypeSafe System One 请求正文。 */
export interface SystemOneWireRequest {
	state: ClassifierContext["state"];
	questions: Record<string, unknown>;
}

/** 提供 System One 模型的各服务之间的差异配置。 */
export interface SystemOneTransport {
	/** 此传输实现的分类 API。 */
	api: ClassifierApi;
	/** 错误消息中使用的服务名称。 */
	label: string;
	/** 请求的绝对 URL。 */
	url(model: ClassifierModel<ClassifierApi>): URL;
	/** 将 System One 请求封装到服务要求的请求结构中。 */
	payload(model: ClassifierModel<ClassifierApi>, request: SystemOneWireRequest): unknown;
	/** 从服务的响应结构中提取 System One 输出（`{ answers, usage }`）。 */
	output(body: unknown): Record<string, unknown>;
}

function probabilities(label: string, value: unknown, id: string): Record<string, number> {
	if (!isRecord(value)) throw new Error(`${label} returned invalid probabilities for ${id}`);
	return Object.fromEntries(
		Object.entries(value).map(([key, probability]) => [
			key,
			requiredNumber(label, probability, `probability for ${id}.${key}`),
		]),
	);
}

function parseAnswers(label: string, value: unknown, context: ClassifierContext): Record<string, ClassifierAnswer> {
	if (!isRecord(value)) throw new Error(`${label} returned an unexpected response`);
	const answers: Array<[string, ClassifierAnswer]> = [];
	for (const [id, question] of Object.entries(context.questions)) {
		const answer = value[id];
		if (!isRecord(answer)) throw new Error(`${label} did not return an answer for ${id}`);
		if (question.type === "choice") {
			if (answer.type !== "choice" || typeof answer.choice !== "string") {
				throw new Error(`${label} did not return a choice answer for ${id}`);
			}
			answers.push([
				id,
				{
					type: "choice",
					choice: answer.choice,
					probabilities: probabilities(label, answer.probabilities, id),
					confidence: requiredNumber(label, answer.confidence, `confidence for ${id}`),
				},
			]);
		} else if (question.type === "score") {
			if (answer.type !== "score") throw new Error(`${label} did not return a score answer for ${id}`);
			answers.push([
				id,
				{
					type: "score",
					score: requiredNumber(label, answer.score, `score for ${id}`),
					confidence: requiredNumber(label, answer.confidence, `confidence for ${id}`),
				},
			]);
		} else {
			if (answer.type !== "noul") throw new Error(`${label} did not return a bool answer for ${id}`);
			answers.push([
				id,
				{
					type: "bool",
					probability: requiredNumber(label, answer.noul, `probability for ${id}`),
				},
			]);
		}
	}
	return Object.fromEntries(answers);
}

/** 将公开接口中的 `bool` 问题映射为 TypeSafe 线上协议使用的 `noul` 类型。 */
function wireRequest(context: ClassifierContext): SystemOneWireRequest {
	return {
		state: context.state,
		questions: Object.fromEntries(
			Object.entries(context.questions).map(([id, question]) => [
				id,
				question.type === "bool" ? { ...question, type: "noul" } : question,
			]),
		),
	};
}

/** 通过给定传输执行一次 System One 分类请求。 */
export async function classifySystemOne(
	transport: SystemOneTransport,
	model: ClassifierModel<ClassifierApi>,
	context: ClassifierContext,
	options: ClassifierOptions | undefined,
): Promise<ClassifierResult> {
	const output: ClassifierResult = {
		api: model.api,
		provider: model.provider,
		model: model.id,
		answers: {},
		stopReason: "stop",
		timestamp: Date.now(),
	};

	try {
		if (model.api !== transport.api) throw new Error(`Unsupported classifier API: ${model.api}`);
		if (context.images?.length) throw new Error(`${transport.label} does not support image input`);
		const body = await postClassifierRequest(
			transport.label,
			transport.url(model),
			model,
			transport.payload(model, wireRequest(context)),
			options,
		);
		const result = transport.output(body);
		// 在解析答案前设置：即使答案格式错误，该请求仍会计费。
		const usage = parseClassifierUsage(result.usage, model);
		if (usage) output.usage = usage;
		output.answers = parseAnswers(transport.label, result.answers, context);
		return output;
	} catch (error) {
		output.stopReason = options?.signal?.aborted ? "aborted" : "error";
		output.errorMessage = formatProviderError(normalizeProviderError(error), `${transport.label} error`);
		return output;
	}
}
