import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("before_provider_request", (event, ctx) => {
		const logFile = join(ctx.cwd, CONFIG_DIR_NAME, "provider-payload.log");
		appendFileSync(logFile, `${JSON.stringify(event.payload, null, 2)}\n\n`, "utf8");

		// 可选：替换请求负载，而不仅仅是记录日志。
		// return { ...event.payload, temperature: 0 };
	});

	pi.on("after_provider_response", (event, ctx) => {
		const logFile = join(ctx.cwd, CONFIG_DIR_NAME, "provider-payload.log");
		appendFileSync(logFile, `[${event.status}] ${JSON.stringify(event.headers)}\n\n`, "utf8");
	});
}
