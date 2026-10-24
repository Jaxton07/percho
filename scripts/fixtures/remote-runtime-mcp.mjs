import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
	const request = JSON.parse(line);
	let result;
	if (request.method === "initialize")
		result = {
			protocolVersion: "2024-11-05",
			capabilities: { tools: {} },
			serverInfo: { name: "remote-test", version: "1" },
		};
	else if (request.method === "tools/list")
		result = {
			tools: [
				{
					name: "remote_probe",
					description: "Read remote runtime test marker",
					inputSchema: { type: "object", properties: {} },
				},
			],
		};
	else if (request.method === "tools/call") {
		writeFileSync(`${process.env.PI_CODING_AGENT_DIR}/mcp-proof`, "REMOTE_MCP_SENTINEL");
		result = { content: [{ type: "text", text: "REMOTE_MCP_SENTINEL" }] };
	} else if (request.id !== undefined) result = {};
	if (request.id !== undefined)
		process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
});
