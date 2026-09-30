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

/** 仅翻译已知内置工具，MCP/扩展工具的名称原样保留。 */
export function displayName(name: string, t?: Translate): string {
	if (!BUILTIN_TOOL_NAMES.has(name)) return name;
	const key = `tool.names.${name as BuiltinToolName}` as const;
	// 插件 host API 的单参数调用也跟随当前语言；组件传 useT() 保证切换时重渲染。
	return t ? t(key) : translate(useI18nStore.getState().language, key);
}
