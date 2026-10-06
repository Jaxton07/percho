// 最小 MCP stdio server —— 端到端验证 MCP 集成用的夹具（零依赖，手写 JSON-RPC 2.0 over stdio）。
//
// 用途：本仓装不上官方 `@modelcontextprotocol/sdk`（不在依赖树里），而 MCP 的面板 / exposure /
// tool_search / 权限声明层都需要一个**真能连上**的 server 才能端到端验证。**能装官方 SDK 时优先换官方**
// （官方 server 有握手/能力协商的完整实现，这个夹具只实现够用的一层）。
//
// 跑法（不进任何默认配置，只由 `mcp.json` 显式指过来）：
//   node scripts/fake-mcp-server.mjs
// 对应的 mcp.json 片段（放进 <agentDir>/mcp.json；agentDir 默认 ~/.pi/agent）：
//   {
//     "mcpServers": {
//       "demo": {
//         "command": "node",
//         "args": ["<仓库绝对路径>/scripts/fake-mcp-server.mjs"],
//         "description": "本地假 MCP server（scripts/fake-mcp-server.mjs）"
//       }
//     },
//     "autoEnableCodemode": false
//   }
// 注意：不写 `exposure` 时官方默认 **codemode**（工具进 codemode 脚本、不在模型工具表里）；
// 想在模型工具表里直接看到，就写 `"exposure": "direct"`，想验证 deferred 就写 `"exposure": "deferred"`。
//
// 暴露的工具（`tools/list` 返回）：
//   - `echo`  ：回显入参，**带 `annotations.readOnlyHint: true`** → 权限声明层应放行（不弹确认）
//   - `nuke`  ：**无声明的写类工具** → 权限声明层应弹确认（`readOnlyHint` 缺失 = ask）
// 以及 `tools/call` / `resources/list` / `prompts/list`（空列表）的最小实现。
let buf = "";
process.stdin.on("data", (chunk) => {
	buf += chunk.toString();
	let idx = buf.indexOf("\n");
	while (idx !== -1) {
		const line = buf.slice(0, idx).trim();
		buf = buf.slice(idx + 1);
		if (line) {
			try {
				handle(JSON.parse(line));
			} catch (err) {
				process.stderr.write(`fake-mcp parse error: ${String(err)}\n`);
			}
		}
		idx = buf.indexOf("\n");
	}
});
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
function handle(msg) {
	if (msg.method === "initialize") {
		send({
			jsonrpc: "2.0",
			id: msg.id,
			result: {
				protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
				capabilities: { tools: {} },
				serverInfo: { name: "fake-mcp", version: "1.0.0" },
			},
		});
		return;
	}
	if (msg.method === "notifications/initialized" || msg.method === undefined) return; // 通知不回
	if (msg.method === "tools/list") {
		send({
			jsonrpc: "2.0",
			id: msg.id,
			result: {
				tools: [
					{
						name: "echo",
						description: "Echo text back (read-only demo).",
						inputSchema: {
							type: "object",
							properties: { text: { type: "string" } },
							required: ["text"],
						},
						annotations: { readOnlyHint: true },
					},
					{
						name: "nuke",
						description: "Destructive demo tool (no annotations).",
						inputSchema: { type: "object", properties: {} },
					},
				],
			},
		});
		return;
	}
	if (msg.method === "tools/call") {
		send({
			jsonrpc: "2.0",
			id: msg.id,
			result: { content: [{ type: "text", text: `ok:${JSON.stringify(msg.params?.arguments ?? {})}` }] },
		});
		return;
	}
	if (msg.method === "resources/list") {
		send({ jsonrpc: "2.0", id: msg.id, result: { resources: [] } });
		return;
	}
	if (msg.method === "prompts/list") {
		send({ jsonrpc: "2.0", id: msg.id, result: { prompts: [] } });
		return;
	}
	if (msg.id !== undefined) {
		send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
	}
}
