import { defineService, type ReplicatedState } from "@earendil-works/chord";
import type { ConversationView } from "@earendil-works/pi-durable";

/** 根会话的持久化视图：活动条目，以及其实时、收件箱、代理和用量文档。 */
export interface Transcript {
	readonly state: ReplicatedState<ConversationView>;
}

export const Transcript = defineService<Transcript>("pi.transcript");
