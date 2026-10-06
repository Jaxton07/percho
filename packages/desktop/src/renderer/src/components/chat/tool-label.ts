import { parseMcpToolName } from "@percho/shared";
import { type Translate, translate, useI18nStore } from "../../i18n";
import type { Messages } from "../../i18n/zh";

type BuiltinToolName = keyof Messages["tool"]["names"];
const BUILTIN_TOOL_NAMES = new Set<string>([
	"read",
	"edit",
	"write",
	"bash",
	"ls",
	"glob",
	"grep",
	"webfetch",
	"show_image",
	"todo",
	"subagent",
	"channel_subscribe",
	"channel_unsubscribe",
	"channel_post",
	"channel_list",
] satisfies BuiltinToolName[]);

/**
 * 工具显示名：内置工具查翻译表；**MCP 工具保留命名空间**（`mcp__<server>__<tool>` → `server › tool`，
 * 不同 server 的同名工具才不会撞脸）；其余扩展工具原名呈现。
 */
export function displayName(name: string, t?: Translate): string {
	const mcp = parseMcpToolName(name);
	if (mcp) return `${mcp.server} › ${mcp.tool}`;
	if (!BUILTIN_TOOL_NAMES.has(name)) return name;
	const key = `tool.names.${name as BuiltinToolName}` as const;
	// 插件 host API 的单参数调用也跟随当前语言；组件传 useT() 保证切换时重渲染。
	return t ? t(key) : translate(useI18nStore.getState().language, key);
}
