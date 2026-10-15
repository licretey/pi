import { type Context, defineFacet, type Facet } from "@earendil-works/chord";
import type { Conversation } from "@earendil-works/pi-durable";
import { Transcript } from "./transcript.ts";

/** 提供会话的持久化视图状态；此功能面负责管理并释放已连接的状态。 */
export async function createTranscriptServiceFacet(conversation: Conversation, context: Context): Promise<Facet> {
	const state = await conversation.viewState(context);
	return defineFacet({
		id: "@pi/transcript",
		setup(env) {
			env.own(() => state.dispose());
			env.provide(Transcript, { state });
		},
	});
}
