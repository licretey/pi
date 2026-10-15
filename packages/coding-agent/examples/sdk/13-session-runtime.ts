/**
 * 会话运行时。
 *
 * 需要替换当前 AgentSession 时使用 AgentSessionRuntime，
 * 例如新建会话、恢复会话、分叉或导入会话。
 *
 * 关键做法是：运行时替换当前会话后，
 * 将会话级订阅和扩展绑定重新关联到 `runtime.session`。
 */

import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	getAgentDir,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
	const services = await createAgentSessionServices({ cwd });
	return {
		...(await createAgentSessionFromServices({
			services,
			sessionManager,
			sessionStartEvent,
		})),
		services,
		diagnostics: services.diagnostics,
	};
};
const runtime = await createAgentSessionRuntime(createRuntime, {
	cwd: process.cwd(),
	agentDir: getAgentDir(),
	sessionManager: SessionManager.create(process.cwd()),
});

let unsubscribe: (() => void) | undefined;

async function bindSession() {
	unsubscribe?.();
	const session = runtime.session;
	await session.bindExtensions({});
	unsubscribe = session.subscribe((event) => {
		if (event.type === "queue_update") {
			console.log("Queued:", event.steering.length + event.followUp.length);
		}
	});
	return session;
}

let session = await bindSession();
const originalSessionFile = session.sessionFile;
console.log("Initial session:", originalSessionFile);

await runtime.newSession();
session = await bindSession();
console.log("After newSession():", session.sessionFile);

if (originalSessionFile) {
	await runtime.switchSession(originalSessionFile);
	session = await bindSession();
	console.log("After switchSession():", session.sessionFile);
}

unsubscribe?.();
await runtime.dispose();
