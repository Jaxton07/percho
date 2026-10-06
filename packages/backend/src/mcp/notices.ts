import type { McpGlobalNotice } from "@percho/shared";

/**
 * 官方 mcp 扩展的 notify 文本解析（1.0.4 `dist/extensions/mcp/index.js`）—— 面板的「失败原因 / 需要登录」
 * 数据源。官方没有给我们状态 API，但它在三个时机 notify 出结构化文本，照这些形状解析即可（`reportProblems` L480-489）：
 *
 * | notify 文本 | 含义 |
 * |---|---|
 * | `MCP servers need attention:\n  <name>: <state>\n…\nRun /mcp to fix.` | 每台有问题的 server 一行，`<state>` = `needs sign-in` 或 `failed: <错误首行>` |
 * | `Sign in to MCP server "<name>" in your browser:\n<url>` | 该 server 正在走 OAuth → needsAuth |
 * | `Signed in to MCP server "<name>" (N tools).` | 登录成功 → 清掉该 server 的标记 |
 * | `MCP failed to load: <err>` | 整体加载失败（配置解析等） → 全局 error |
 * | `MCP tools are only reachable from the codemode or tool_search tool, but neither is active…` | 工具不可达（两个入口都没激活） → 全局 warning |
 * | `MCP servers are still connecting; …` | 正在连（信息级） → 全局 info（面板可以不显） |
 *
 * 解析失败一律返回 undefined —— **不猜**，面板回落到「未连上」这一档（宁缺勿错）。
 */

export interface McpNoticeUpdate {
	/** 本次 notify 涉及的 server（按名字）→ 新的状态标记；`clear: true` 表示清掉（如登录成功） */
	servers: { name: string; error?: string; needsAuth?: boolean; authUrl?: string; clear?: boolean }[];
	/** 不带 server 名的全局提示；`null` = 清掉 */
	global?: McpGlobalNotice | null;
}

const ATTENTION_HEADER = "MCP servers need attention:";

/** `<name>: needs sign-in` / `<name>: failed: <reason>` / `<name>: <其它状态>` */
function parseAttentionLine(line: string): { name: string; error?: string; needsAuth?: boolean } | undefined {
	const idx = line.indexOf(": ");
	if (idx <= 0) return undefined;
	const name = line.slice(0, idx).trim();
	const state = line.slice(idx + 2).trim();
	if (!name) return undefined;
	if (state === "needs sign-in") return { name, needsAuth: true };
	if (state.startsWith("failed")) {
		const reason = state.replace(/^failed:\s*/, "").trim();
		return { name, error: reason || "failed" };
	}
	// connecting… / connected · N tools / disabled 不进「需要处理」名单 → 不解析成失败
	return undefined;
}

export function parseMcpNotice(message: string): McpNoticeUpdate | undefined {
	const text = message.trim();

	if (text.startsWith(ATTENTION_HEADER)) {
		const lines = text
			.split("\n")
			.map((line) => line.trim())
			.filter(
				(line) => line.length > 0 && !line.startsWith(ATTENTION_HEADER) && !line.startsWith("Run /mcp"),
			);
		const servers: McpNoticeUpdate["servers"] = [];
		const configErrors: string[] = [];
		for (const line of lines) {
			if (line.startsWith("config:")) {
				configErrors.push(line.slice("config:".length).trim());
				continue;
			}
			const parsed = parseAttentionLine(line);
			if (parsed) servers.push(parsed);
		}
		const update: McpNoticeUpdate = { servers };
		if (configErrors.length > 0) {
			update.global = { level: "error", message: `mcp.json：${configErrors.join("；")}` };
		}
		return update;
	}

	const signIn = text.match(/^Sign in to MCP server "(.+?)"[^\n]*\n\s*(https?:\/\/\S+)/);
	if (signIn?.[1]) return { servers: [{ name: signIn[1], needsAuth: true, authUrl: signIn[2] }] };

	const signedIn = text.match(/^Signed in to MCP server "(.+?)"/);
	if (signedIn?.[1]) return { servers: [{ name: signedIn[1], clear: true }] };

	const loadFailed = text.match(/^MCP failed to load:\s*([\s\S]+)$/);
	if (loadFailed?.[1]) return { servers: [], global: { level: "error", message: loadFailed[1].trim() } };

	if (text.includes("MCP tools are only reachable from the codemode or tool_search tool")) {
		return { servers: [], global: { level: "warning", message: text } };
	}

	if (text.startsWith("MCP servers are still connecting")) {
		return { servers: [], global: null };
	}

	return undefined;
}
