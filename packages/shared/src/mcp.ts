/**
 * MCP（Model Context Protocol）配置与运行态的宿主侧契约。
 *
 * 分工（spec §4.8 / §4.8.1）：
 * - **配置**：官方读 `<agentDir>/mcp.json`（用户级）与受信项目的 `<cwd>/.pi/mcp.json`（项目级）；
 *   我们只做 JSON 读写 + 形状校验 + 面板呈现，**不实现连接、不做 `${VAR}` 展开**（展开交给官方）。
 * - **运行态**：官方扩展报告原始身份与完整连接快照；工具名只用于执行/历史展示，不能反推配置身份。
 */

/** 官方 `McpExposure`（server 级 / 逐工具覆盖都用它）；**缺省 = "codemode"**（不是 direct） */
export const MCP_EXPOSURES = ["deferred", "codemode", "direct", "hidden"] as const;
export type McpExposure = (typeof MCP_EXPOSURES)[number];

/** 传输方式（面板只做展示与表单，不解析 `${VAR}`） */
export type McpTransportView =
	| { kind: "stdio"; command: string; args?: string[] }
	| { kind: "url"; url: string }
	| { kind: "unknown" };

/** 单个 MCP 工具（官方 `ToolInfo.annotations.readOnlyHint` 映射过来） */
export interface McpToolView {
	name: string;
	/** 只读（免确认）；false/undefined = 会改动 → 调用要确认 */
	readOnly?: boolean;
}

/** 连接状态独立于工具库存；未知不等于断开。 */
export type McpConnectionState =
	| "not-started"
	| "unknown"
	| "connecting"
	| "connected"
	| "disconnected"
	| "needs-auth"
	| "failed"
	| "closed"
	| "disabled"
	| "overridden";

/** 官方扩展报告的原始服务器身份与当前运行态。 */
export interface McpServerStatus {
	name: string;
	source?: string;
	scope?: "global" | "project" | "extension";
	override?: string;
	state?: McpConnectionState;
	tools: McpToolView[];
	/** SDK 当前连接诊断；恢复后完整快照清除旧值。 */
	error?: string;
	/** 官方连接状态 = needs-auth（远程 server 需要 OAuth 登录） */
	needsAuth?: boolean;
	/** 可选授权入口；浏览器打开仍由既有 SDK openUrl 桥接。 */
	authUrl?: string;
}

/** 官方扩展报告的全局提示，如工具发现能力不可达。 */
export interface McpGlobalNotice {
	level: "info" | "warning" | "error";
	message: string;
}

/** 单个 MCP server 的视图（配置 + 运行态合流） */
export interface McpServerView {
	name: string;
	/** 当前选定实例的明确状态；兼容旧配置夹具缺省，但不得从工具数量推断。 */
	state?: McpConnectionState;
	source: "user" | "project";
	/** 项目条目只覆盖全局服务器的运行设置。 */
	isOverride?: boolean;
	/** 项目配置实际有效地覆盖了同名全局配置。 */
	overridesGlobal?: boolean;
	transport: McpTransportView;
	description?: string;
	enabled: boolean;
	/** 投影前的配置启用状态，不受运行实例影响。 */
	configuredEnabled?: boolean;
	/** 原配置中的档位字符串；非法值也保留供诊断，编辑时不能静默替换。 */
	exposureRaw?: string;
	/** 支持的展示档位；缺省/非法值回落 codemode，非法原值另附官方诊断。 */
	exposure: McpExposure;
	/** 逐工具覆盖（原样呈现） */
	toolExposure?: Record<string, McpExposure>;
	/** 运行态：该服务器当前报告的工具库存，与连接状态独立。 */
	tools: McpToolView[];
	/** 运行态：SDK 当前连接失败原因。 */
	error?: string;
	/** 运行态：需要 OAuth 登录 */
	needsAuth?: boolean;
	/** 运行态：官方给出的授权页 URL（点「登录」时打开） */
	authUrl?: string;
}

/** `mcp.config:list` 结果 */
export interface McpConfigListResult {
	global: McpServerView[];
	project: McpServerView[];
	/** 配置文件形状/读写错误（面板红字展示，不阻塞会话） */
	errors: string[];
	/** 项目级配置只有受信项目才读（官方 trust-manager 同款） */
	projectTrusted: boolean;
	/** 当前选中实例的官方全局提示。 */
	notice?: McpGlobalNotice;
	globalPath: string;
	projectPath?: string;
	/** 同一后端的完整实例快照，查询与事件共用修订。 */
	runtime?: McpRuntimeInventory;
	selectedInstanceId?: string;
	/** 后端确认的字面项目路径，避免 renderer 用跨环境 UI 引用比对。 */
	contextCwd?: string;
	runtimeErrors?: string[];
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

/** 一次 SDK 装载的运行实例；reload 会产生新的 instanceId。 */
export interface McpRuntimeInstance {
	instanceId: string;
	sessionId: string;
	cwd: string;
	/** 官方扩展被替换时无可靠观察源，状态只能是 unknown。 */
	available: boolean;
	servers: McpServerStatus[];
	errors: string[];
	notice?: McpGlobalNotice;
}

/** 完整后端快照；epoch 区分宿主重启，revision 在同一 epoch 内递增。 */
export interface McpRuntimeInventory {
	epoch: string;
	revision: number;
	instances: McpRuntimeInstance[];
}

export type McpServersChangedPayload = McpRuntimeInventory;

/** MCP 工具名前缀（官方 `extensions/mcp/tools.js`：`mcp__<server>__<tool>`） */
export const MCP_TOOL_PREFIX = "mcp__";

/** 仅供历史分类与显示的有损拆分，不能用于运行态或配置身份关联。 */
export function parseMcpToolName(toolName: string): { server: string; tool: string } | undefined {
	if (!toolName.startsWith(MCP_TOOL_PREFIX)) return undefined;
	const rest = toolName.slice(MCP_TOOL_PREFIX.length);
	const sep = rest.indexOf("__");
	if (sep <= 0 || sep + 2 >= rest.length) return undefined;
	return { server: rest.slice(0, sep), tool: rest.slice(sep + 2) };
}

/**
 * 写盘/重连后的会话 reload 报告。
 *
 * 忙碌会话跳过，SDK 也会在 shutdown 前拒绝忙碌的 reload；其他失败同样报告给 UI。
 */
export interface McpReloadReport {
	reloaded: number;
	skipped: { sessionId: string; reason: "streaming" | "compacting" | "failed" }[];
}

/** 写盘类 MCP 动作的结果：新配置 + 哪些会话没跟着重连 */
export interface McpMutationResult {
	config: McpConfigListResult;
	reload: McpReloadReport;
}
