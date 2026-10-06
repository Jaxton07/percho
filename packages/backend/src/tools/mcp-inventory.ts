import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { McpServerStatus, McpToolView } from "@percho/shared";
import { groupMcpTools } from "@percho/shared";

export { groupMcpTools, MCP_TOOL_PREFIX, parseMcpToolName } from "@percho/shared";

/** `getAllTools()` 里一条工具能喂给面板的信息（name + 官方声明的只读性） */
export interface McpToolInfo {
	name: string;
	readOnly?: boolean;
}

/** 从工具清单聚合出「server → 工具（带只读标记）」（面板数据源；也用于从 tool 名反推 server） */
export function collectMcpTools(tools: readonly McpToolInfo[]): Map<string, McpToolView[]> {
	const grouped = groupMcpTools(tools.map((tool) => tool.name));
	const readOnlyByName = new Map(tools.map((tool) => [tool.name, tool.readOnly === true]));
	const result = new Map<string, McpToolView[]>();
	for (const [server, names] of grouped) {
		result.set(
			server,
			names.map((name) => ({ name, readOnly: readOnlyByName.get(name) || undefined })),
		);
	}
	return result;
}

/**
 * MCP 运行态聚合扩展（spec §4.8.1）：
 * 官方 mcp 扩展把 server 工具注册成 `mcp__<server>__<tool>`，但没有「哪台 server 有哪些工具」的现成 API ——
 * 我们在三个时机调 `pi.getAllTools()` 聚合一次（顺带把 `annotations.readOnlyHint` 带出来给面板标只读），
 * **集合变化时才回调**（payload 可能不小，不能每个 turn 都推）：
 * `session_start`（含恢复）、`before_agent_start`（deferred 工具被激活后）、`turn_end`（动态 server 变化）。
 *
 * 注意：工具集合 ≠ 连接状态 —— `deferred` 暴露的工具注册但不 active，`getAllTools()` 一样能看到
 * （它给的是「已配置工具」），所以面板上「有工具」可当「已连上」看；失败/需授权的原因另有官方 notify（见 mcp-notices.ts）。
 */
export function makeMcpInventoryExtension(onChange: (servers: McpServerStatus[]) => void): InlineExtension {
	return {
		name: "mcp-inventory",
		factory: (pi) => {
			let lastKey = "";
			const report = () => {
				const tools = pi.getAllTools().map((tool) => ({
					name: tool.name,
					readOnly: tool.annotations?.readOnlyHint === true,
				}));
				const statuses: McpServerStatus[] = [...collectMcpTools(tools)].map(([name, list]) => ({
					name,
					tools: list,
				}));
				const key = JSON.stringify(statuses);
				if (key === lastKey) return;
				lastKey = key;
				onChange(statuses);
			};
			pi.on("session_start", report);
			pi.on("before_agent_start", report);
			pi.on("turn_end", report);
		},
	};
}
