/**
 * 浏览器登录流程共用的 loopback OAuth 重定向处理器。
 *
 * 注意：此模块使用 node:http。它只会通过延迟加载的 OAuth 流程模块访问，不会从面向浏览器的入口加载。
 */

import { createServer, type ServerResponse } from "node:http";
import { oauthErrorHtml, oauthSuccessHtml } from "../../utils/oauth-page.ts";
import type { ProviderAuthInteraction } from "../types.ts";

export interface OAuthCallbackServerOptions<T> {
	/** 在浏览器页面中显示的提供商名称，例如 `OpenAI`。 */
	providerName: string;
	/** 要监听的地址。 */
	host: string;
	/** 监听端口；设为 `0` 时由系统分配可用端口。 */
	port: number;
	path: string;
	/** 当 `redirectUri` 中的主机名与 `host` 不同时使用，例如 `localhost`。 */
	redirectHost?: string;
	/** 预期的 `state` 参数；提供商不会发送该参数时省略。 */
	state?: string;
	/**
	 * 在发送浏览器页面前，使用收到的 code 完成登录，使页面能够显示兑换失败信息。
	 * 如果要延后兑换 code，请传入 `async (code) => code`。
	 */
	complete: (code: string) => Promise<T>;
	signal?: AbortSignal;
	timeoutMs?: number;
}

export interface OAuthCallbackServer<T> {
	redirectUri: string;
	/**
	 * 成功时返回 `complete` 的结果；调用 `cancel()` 后返回 `undefined`。提供商重定向包含错误、`complete` 失败、
	 * signal 中止或等待超时都会导致 Promise 拒绝。
	 */
	wait(): Promise<T | undefined>;
	/** 停止等待浏览器回调，但已开始处理的回调会继续完成。 */
	cancel(): void;
	close(): void;
}

function sendPage(response: ServerResponse, status: number, html: string): void {
	response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
	response.end(html);
}

export async function startOAuthCallbackServer<T>(
	options: OAuthCallbackServerOptions<T>,
): Promise<OAuthCallbackServer<T>> {
	const { providerName, signal } = options;
	if (signal?.aborted) throw new Error("Login cancelled");

	let resolveWait: (value: T | undefined) => void = () => {};
	let rejectWait: (error: Error) => void = () => {};
	const waitPromise = new Promise<T | undefined>((resolve, reject) => {
		resolveWait = resolve;
		rejectWait = reject;
	});
	// 已取消或已关闭的等待操作可能永远不会被观察到。
	waitPromise.catch(() => undefined);

	let claimed = false;
	let settled = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const onAbort = () => finish({ error: new Error("Login cancelled") });
	const finish = (result: { value: T | undefined } | { error: Error }): void => {
		if (settled) return;
		settled = true;
		if (timer) clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
		if ("error" in result) rejectWait(result.error);
		else resolveWait(result.value);
	};

	const server = createServer((request, response) => {
		void (async () => {
			const url = new URL(request.url ?? "/", "http://localhost");
			if (request.method !== "GET" || url.pathname !== options.path) {
				sendPage(response, 404, oauthErrorHtml("Callback route not found."));
				return;
			}
			if (options.state !== undefined && url.searchParams.get("state") !== options.state) {
				sendPage(response, 400, oauthErrorHtml("State mismatch."));
				return;
			}
			if (claimed || settled) {
				sendPage(response, 409, oauthErrorHtml("This sign-in has already been handled."));
				return;
			}
			const error = url.searchParams.get("error");
			if (error) {
				const description = url.searchParams.get("error_description") ?? error;
				sendPage(response, 400, oauthErrorHtml(`${providerName} authorization failed.`, description));
				finish({ error: new Error(`${providerName} authorization failed: ${description}`) });
				return;
			}
			const code = url.searchParams.get("code");
			if (!code) {
				sendPage(response, 400, oauthErrorHtml("Missing authorization code."));
				return;
			}
			claimed = true;
			try {
				const value = await options.complete(code);
				sendPage(response, 200, oauthSuccessHtml(`Signed in to ${providerName}. You may now close this page.`));
				finish({ value });
			} catch (error) {
				const failure = error instanceof Error ? error : new Error(String(error));
				sendPage(response, 502, oauthErrorHtml(`${providerName} sign-in failed.`, failure.message));
				finish({ error: failure });
			}
		})();
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port, options.host, () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		server.close();
		throw new Error("OAuth callback server did not bind to TCP");
	}

	server.on("error", (error) => finish({ error }));
	signal?.addEventListener("abort", onAbort, { once: true });
	if (options.timeoutMs !== undefined) {
		timer = setTimeout(() => finish({ error: new Error(`${providerName} sign-in timed out`) }), options.timeoutMs);
	}
	const redirectHost = options.redirectHost ?? options.host;
	return {
		redirectUri: `http://${redirectHost.includes(":") ? `[${redirectHost}]` : redirectHost}:${address.port}${options.path}`,
		wait: () => waitPromise,
		cancel: () => {
			if (!claimed) finish({ value: undefined });
		},
		close: () => {
			finish({ error: new Error("OAuth callback server closed") });
			server.close();
		},
	};
}

/**
 * 等待浏览器回调；如果浏览器无法访问 loopback 服务器（例如通过 SSH 远程使用），则等待用户粘贴 code 或重定向 URL。
 * 不使用回调服务器时，只支持手动输入。
 */
export async function waitForCallbackOrManualInput<T>(
	interaction: ProviderAuthInteraction,
	callback: OAuthCallbackServer<T> | undefined,
	prompt: { message: string; placeholder: string },
): Promise<{ type: "callback"; value: T } | { type: "manual"; input: string }> {
	const manualAbort = new AbortController();
	let manualError: Error | undefined;
	const manual = interaction
		.prompt({ type: "manual_code", ...prompt, signal: manualAbort.signal })
		.then((input) => {
			callback?.cancel();
			return input;
		})
		.catch((error: unknown) => {
			manualError = error instanceof Error ? error : new Error(String(error));
			callback?.cancel();
			return undefined;
		});
	try {
		const value = await callback?.wait();
		if (manualError) throw manualError;
		if (value !== undefined) return { type: "callback", value };
		const input = await manual;
		if (manualError) throw manualError;
		return { type: "manual", input: input ?? "" };
	} finally {
		manualAbort.abort();
	}
}
