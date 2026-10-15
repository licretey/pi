/**
 * 一个智能体，既可直接使用 MCP 服务器提供的工具，也可通过 codemode 工具从 JavaScript 调用它们。
 *
 *   ANTHROPIC_API_KEY=... node packages/agent/examples/mcp-codemode/main.ts \
 *     npx -y @modelcontextprotocol/server-filesystem .
 *
 * 参数是用于启动 stdio MCP 服务器的命令及其参数。
 */

import { Agent } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { McpClient, StdioTransport } from "@earendil-works/pi-mcp";
import { createCodemodeTool, createMcpTools, createNestedToolRunner } from "./tools.ts";

const [command, ...args] = process.argv.slice(2);
if (!command) {
	console.error("Usage: main.ts <mcp server command> [args...]");
	process.exit(1);
}

const models = createModels();
models.setProvider(anthropicProvider());
const model = models.getModel("anthropic", "claude-sonnet-4-6");
if (!model) throw new Error("Model not found");

const client = new McpClient({ name: "pi-agent-example", version: "1.0.0" });
await client.connect(new StdioTransport({ command, args }));

try {
	const agent = new Agent({
		initialState: { systemPrompt: "You are a helpful assistant.", model },
		streamFn: models.streamSimple.bind(models),
	});
	const mcpTools = await createMcpTools(client, "mcp");
	// 模型可以直接调用 MCP 工具，也可以在一个 codemode 脚本中批量调用它们。
	agent.state.tools = [...mcpTools, createCodemodeTool(mcpTools, createNestedToolRunner(agent))];

	agent.subscribe((event) => {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			process.stdout.write(event.assistantMessageEvent.delta);
		} else if (event.type === "tool_execution_start") {
			console.log(`\n[${event.toolName}]`);
		}
	});
	await agent.prompt("Use codemode to list what the MCP tools can do, then summarize it in two sentences.");
	console.log();
} finally {
	await client.close();
}
