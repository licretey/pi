import { type Context, defineService, type JsonValue } from "@earendil-works/chord";

/** 可供呈现层使用、由服务器构建的插件版本。 */
export interface PresentationPlugins {
	prepareSession(
		request: { readonly sessionId: string; readonly packagePaths: readonly string[] | null },
		context: Context,
	): Promise<JsonValue>;
	reload(context: Context): Promise<JsonValue>;
}

export const PresentationPlugins = defineService<PresentationPlugins>("pi.presentation-plugins");

/** 当前已连接会话工作进程托管的插件功能面。 */
export interface SessionPlugins {
	reload(context: Context): Promise<void>;
}

export const SessionPlugins = defineService<SessionPlugins>("pi.session-plugins");
