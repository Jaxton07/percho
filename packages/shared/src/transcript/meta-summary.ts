import { parseMcpToolName } from "../mcp";
import type { UIToolCall } from "./types";

/** 折叠组工具的语义分类（展示统计用）；未知工具归 other（按原始工具名各自计数）；subagent 为正向汇总段（不计工具明细） */
export type ToolCategory = "read" | "edit" | "explore" | "search" | "bash" | "mcp" | "other" | "subagent";

/**
 * 工具名 → 语义类目：edit/write 同为「编辑」，ls/glob 同为「探索」，grep 单独「搜索」，
 * MCP 工具（`mcp__<server>__<tool>`）归「mcp」——一个 server 常有几十个工具，逐名成段会把状态行撑爆。
 */
export function categoryOf(toolName: string): ToolCategory {
	if (parseMcpToolName(toolName)) return "mcp";
	switch (toolName) {
		case "read":
			return "read";
		case "edit":
		case "write":
			return "edit";
		case "ls":
		case "glob":
			return "explore";
		case "grep":
			return "search";
		case "bash":
			return "bash";
		default:
			return "other";
	}
}

/** 圆点：组内一次 tool call 一粒（working 期随调用实时追加，组结束后随 items 冻结） */
export interface MetaDot {
	/** React key（UIToolCall.key，本地稳定） */
	key: string;
	state: "running" | "done" | "error";
}

/**
 * subagent 工具不产圆点/不入统计：直接派发的子代理会在 tool_execution_start 被移出折叠区
 * 成独立行，若先出点再消失会闪点；management 类调用罕见，无点可接受（展开区仍有工具卡）。
 */
const EXCLUDED_TOOLS = new Set(["subagent"]);

/** 圆点序列：组内全部工具按到达顺序展开，每工具一粒（subagent 除外，见 EXCLUDED_TOOLS） */
export function dotsFromItems(items: ReadonlyArray<{ tools: UIToolCall[] }>): MetaDot[] {
	const dots: MetaDot[] = [];
	for (const item of items) {
		for (const tool of item.tools) {
			if (EXCLUDED_TOOLS.has(tool.name)) continue;
			dots.push({ key: tool.key, state: tool.state });
		}
	}
	return dots;
}

/** 分类汇总段；other 段按原始工具名各自成段，mcp 段按 server 成段 */
export interface SummarySegment {
	/** React key：已知类目用类目名，other 用原始工具名，mcp 用 `mcp:<server>` */
	key: string;
	category: ToolCategory;
	/** 原始工具名（other 段显示用；mcp 段显示取 server） */
	name: string;
	/** MCP server 名（category === "mcp" 时才有；显示为 `blender ×3`） */
	server?: string;
	count: number;
}

/** 分类汇总：按首见顺序聚合（同 toolName 的 edit/write 归并为一类，同一 MCP server 的工具归并为一段），other 各自计数；
 *  subagentCount > 0 时末尾追加「子代理」汇总段（spec §9.0 分野：计数来自组的 subagentRuns/固化消息，不经 tools） */
export function summarizeCategories(
	items: ReadonlyArray<{ tools: UIToolCall[] }>,
	subagentCount = 0,
): SummarySegment[] {
	const segments = new Map<string, SummarySegment>();
	for (const item of items) {
		for (const tool of item.tools) {
			// show_image 的图片已在正文外展示，工具仍保留在展开明细与圆点序列中。
			if (EXCLUDED_TOOLS.has(tool.name) || tool.name === "show_image") continue;
			const category = categoryOf(tool.name);
			// MCP 段按 server 归并：`blender › look` + `blender › get_scene_info` → 一段 `blender ×2`
			const mcp = category === "mcp" ? parseMcpToolName(tool.name) : undefined;
			const key = mcp ? `mcp:${mcp.server}` : category === "other" ? tool.name : category;
			const existing = segments.get(key);
			if (existing) existing.count += 1;
			else
				segments.set(key, {
					key,
					category,
					name: tool.name,
					...(mcp ? { server: mcp.server } : {}),
					count: 1,
				});
		}
	}
	const result = [...segments.values()];
	if (subagentCount > 0) {
		result.push({ key: "subagent", category: "subagent", name: "subagent", count: subagentCount });
	}
	return result;
}
