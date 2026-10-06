/**
 * MCP（Model Context Protocol）配置与运行态视图 —— 1.0.4 官方内置扩展接入后的宿主侧契约。
 *
 * 分工（spec §4.8 / §4.8.1）：
 * - **配置**：官方读 `<agentDir>/mcp.json`（用户级）与受信项目的 `<cwd>/.pi/mcp.json`（项目级）；
 *   我们只做 JSON 读写 + 形状校验 + 面板呈现，**不实现连接、不做 `${VAR}` 展开**（展开交给官方）。
 * - **运行态**：官方扩展注册的工具名为 `mcp__<server>__<tool>`；我们的聚合扩展在
 *   `session_start`/`before_agent_start`/`turn_end` 调 `getAllTools()` 过滤前缀，集合变化时发事件。
 */

/** 官方 `McpExposure`（server 级 / 逐工具覆盖都用它）；**缺省 = "codemode"**（不是 direct） */
export type McpExposure = "direct" | "model-only" | "codemode" | "deferred" | "hidden";

/** 传输方式（面板只做展示与表单，不解析 `${VAR}`） */
export type McpTransportView =
	| { kind: "stdio"; command: string; args?: string[] }
	| { kind: "url"; url: string }
	| { kind: "unknown" };

/** 单个 MCP server 的视图（配置 + 运行态合流） */
export interface McpServerView {
	name: string;
	source: "user" | "project";
	transport: McpTransportView;
	description?: string;
	enabled: boolean;
	/** 配置里显式写的 exposure；缺省 undefined = 走官方默认 codemode */
	exposureRaw?: McpExposure;
	/** 生效的 exposure（exposureRaw ?? "codemode"） */
	exposure: McpExposure;
	/** 逐工具覆盖（原样呈现） */
	toolExposure?: Record<string, McpExposure>;
	/** 运行态：已注册的工具名（`mcp__<server>__<tool>`；未连上/未加载为空数组） */
	tools: string[];
}

/** `mcp.config:list` 结果 */
export interface McpConfigListResult {
	global: McpServerView[];
	project: McpServerView[];
	/** 配置文件形状/读写错误（面板红字展示，不阻塞会话） */
	errors: string[];
	/** 项目级配置只有受信项目才读（官方 trust-manager 同款） */
	projectTrusted: boolean;
	globalPath: string;
	projectPath?: string;
}

/** `mcp.config:upsert` 入参（新增/编辑一个 server；缺省 transport 字段保持不变） */
export interface McpUpsertInput {
	scope: "user" | "project";
	cwd?: string;
	name: string;
	command?: string;
	args?: string[];
	url?: string;
	description?: string;
	enabled?: boolean;
	/** 不传 = 新建时写 "deferred"（spec §4.8），编辑时保持原值 */
	exposure?: McpExposure;
}

/** `mcp.tools:changed` 事件载荷（只带按 server 聚合的工具名） */
export interface McpToolsChangedPayload {
	servers: { name: string; tools: string[] }[];
}

/** MCP 工具名前缀（官方 `extensions/mcp/tools.js`：`mcp__<server>__<tool>`） */
export const MCP_TOOL_PREFIX = "mcp__";

/** 解析 MCP 工具名：`mcp__<server>__<tool>` → `{ server, tool }`；不是 MCP 工具则 undefined */
export function parseMcpToolName(toolName: string): { server: string; tool: string } | undefined {
	if (!toolName.startsWith(MCP_TOOL_PREFIX)) return undefined;
	const rest = toolName.slice(MCP_TOOL_PREFIX.length);
	const sep = rest.indexOf("__");
	if (sep <= 0 || sep + 2 >= rest.length) return undefined;
	return { server: rest.slice(0, sep), tool: rest.slice(sep + 2) };
}

/** 按 server 聚合 MCP 工具名（面板数据源） */
export function groupMcpTools(toolNames: readonly string[]): Map<string, string[]> {
	const grouped = new Map<string, string[]>();
	for (const name of toolNames) {
		const parsed = parseMcpToolName(name);
		if (!parsed) continue;
		const list = grouped.get(parsed.server) ?? [];
		list.push(name);
		grouped.set(parsed.server, list);
	}
	for (const list of grouped.values()) list.sort();
	return grouped;
}
