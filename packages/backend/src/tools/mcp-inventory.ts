import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { groupMcpTools } from "@percho/shared";

export { groupMcpTools, MCP_TOOL_PREFIX, parseMcpToolName } from "@percho/shared";

/**
 * MCP 运行态聚合扩展（spec §4.8.1）：官方 mcp 扩展把 server 工具注册成 `mcp__<server>__<tool>`，
 * 但没有「哪个 server 有哪些工具」的现成 API —— 我们在这三个时机调 `pi.getAllTools()` 聚合一次，
 * **集合变化时才回调**（IPC 事件 payload 可能不小，不能每个 turn 都推）：
 * `session_start`（含恢复）、`before_agent_start`（deferred 工具被激活后）、`turn_end`（动态 server 变化）。
 *
 * 注意：工具集合 ≠ 连接状态 —— `deferred` 暴露的工具注册但不 active，`getAllTools()` 一样能看到
 * （它给的是「已配置工具」，不是「已激活工具」），所以面板上「有工具」可当「已连上」看。
 */
export function makeMcpInventoryExtension(
	onChange: (servers: { name: string; tools: string[] }[]) => void,
): InlineExtension {
	return {
		name: "mcp-inventory",
		factory: (pi) => {
			let lastKey = "";
			const report = () => {
				const grouped = groupMcpTools(pi.getAllTools().map((tool) => tool.name));
				const payload = [...grouped.entries()].map(([name, tools]) => ({ name, tools }));
				const key = JSON.stringify(payload);
				if (key === lastKey) return;
				lastKey = key;
				onChange(payload);
			};
			pi.on("session_start", report);
			pi.on("before_agent_start", report);
			pi.on("turn_end", report);
		},
	};
}
