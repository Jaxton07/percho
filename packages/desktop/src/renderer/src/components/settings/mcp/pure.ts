import type { McpServerView, McpToolView, McpUpsertInput } from "@percho/shared";

/** 行的状态（设计稿 §3 状态矩阵）—— 只用一枚 7px 圆点表达，不叠色块 */
export type ServerState = NonNullable<McpServerView["state"]> | "idle" | "error";

/** 连接只以显式状态为准；旧视图缺少状态时兼容授权、错误和 idle。 */
export function serverState(
	server: Pick<McpServerView, "enabled" | "tools" | "error" | "needsAuth" | "state">,
): ServerState {
	if (server.state) return server.state;
	if (!server.enabled) return "disabled";
	if (server.needsAuth) return "needs-auth";
	if (server.error) return "error";
	return "idle";
}

/** 工具摘要：「N 个工具 · 只读 M 个」；无工具给 null（交给状态词） */
export function toolsSummary(tools: readonly McpToolView[]): { count: number; readOnly: number } | null {
	if (tools.length === 0) return null;
	return { count: tools.length, readOnly: tools.filter((tool) => tool.readOnly === true).length };
}

/** 传输方式一行摘要（stdio: command args / 远程: url；不完整给空串） */
export function transportSummary(server: McpServerView): string {
	if (server.transport.kind === "stdio") {
		return [server.transport.command, ...(server.transport.args ?? [])].join(" ");
	}
	if (server.transport.kind === "url") return server.transport.url;
	return "";
}

/** 暴露档位的简短解释（编辑器里当前档位下方那一行） */
export function exposureKey(exposure: string): string {
	return `settings.mcp.exposureExplain.${exposure}`;
}

/** 排序：停用垫底，其余按名称（设计稿 §3：停用排组内最后） */
export function sortServers(servers: McpServerView[]): McpServerView[] {
	return [...servers].sort((a, b) => {
		const disabled = Number(!a.enabled) - Number(!b.enabled);
		if (disabled !== 0) return disabled;
		return a.name.localeCompare(b.name);
	});
}

/** 过滤（搜索框只在服务器 > 8 个时出现；匹配名称/描述/命令） */
export function filterServers(servers: McpServerView[], query: string): McpServerView[] {
	const q = query.trim().toLowerCase();
	if (!q) return servers;
	return servers.filter((server) =>
		[server.name, server.description ?? "", transportSummary(server)].some((text) =>
			text.toLowerCase().includes(q),
		),
	);
}

export const SEARCH_THRESHOLD = 8;

/** 是否需要显示搜索框 */
export function showSearch(servers: McpServerView[]): boolean {
	return servers.length > SEARCH_THRESHOLD;
}

/** 解析粘进来的 `{ "mcpServers": { … } }` 片段 → 一条可保存的输入（设计稿决策点 8） */
export function parsePastedServers(json: string): { entries: McpUpsertInput[]; error?: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch (err) {
		return { entries: [], error: err instanceof Error ? err.message : String(err) };
	}
	const container =
		parsed &&
		typeof parsed === "object" &&
		!Array.isArray(parsed) &&
		(parsed as { mcpServers?: unknown }).mcpServers !== undefined
			? (parsed as { mcpServers: unknown }).mcpServers
			: parsed;
	if (!container || typeof container !== "object" || Array.isArray(container)) {
		return { entries: [], error: 'expecting { "<name>": { command | url } }' };
	}
	const entries: McpUpsertInput[] = [];
	for (const [name, value] of Object.entries(container as Record<string, unknown>)) {
		if (!value || typeof value !== "object" || Array.isArray(value)) continue;
		const entry = value as Record<string, unknown>;
		const command = typeof entry.command === "string" ? entry.command : undefined;
		const url = typeof entry.url === "string" ? entry.url : undefined;
		if (!command && !url) continue;
		entries.push({
			scope: "user",
			name,
			command,
			args: Array.isArray(entry.args)
				? (entry.args as string[]).filter((a) => typeof a === "string")
				: undefined,
			url: command ? undefined : url,
			description: typeof entry.description === "string" ? entry.description : undefined,
		});
	}
	if (entries.length === 0) return { entries: [], error: "没解析出任何 server（需要 command 或 url）" };
	return { entries };
}
