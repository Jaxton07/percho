import { patchStat } from "./parse-patch";
import type { UIMessage, UIToolCall } from "./types";

/**
 * 轮次文件变更派生（纯函数）：UIMessage[] → 每轮的 edit/write 文件变更汇总。
 * chip（轮末「修改了 N 个文件」）与 diff 侧栏共用同一数据源。
 *
 * 轮次边界 = user 消息（与 buildChatRows 的 turnFinalTextIds 同规则）。
 * 数据口径（spec：.local/docs/design/spec/turn-diff.md）：
 * - edit：path 取 args.path，diff 取 tool.diff（SDK details.patch），统计从 patch 数 +/− 行
 * - write：无改前内容 → 全量 + 行伪 diff（added = content 行数，removed 恒 0），content 取 args.content
 * - error 工具、args 解析失败、patch 无实际变更（0/0）一律跳过；bash 等其他工具不统计
 * - 同轮同 path 多次调用合并为一个 TurnFileChange（sections 按调用序累加，统计累加，不合并 hunk）
 */

/** 单文件的一段 diff：一次 edit 调用一段 patch；write 为全量新内容 */
export interface DiffSection {
	/** UIToolCall.key（本地稳定标识）：React key + chip→侧栏跳转锚 */
	toolCallKey: string;
	kind: "edit" | "write";
	/** unified patch（edit 必有） */
	patch?: string;
	/** 文件全量新内容（write 必有） */
	content?: string;
}

export interface TurnFileChange {
	/** 模型给出的原始路径（相对/绝对原样显示，UI 做 RTL 截断） */
	path: string;
	added: number;
	removed: number;
	sections: DiffSection[];
}

export interface TurnChanges {
	/** 第几轮（从 0 计，user 消息为边界） */
	turnIndex: number;
	files: TurnFileChange[];
	totalAdded: number;
	totalRemoved: number;
}

const FILE_TOOL_NAMES = new Set(["edit", "write"]);

function parseToolArgs(args: string): Record<string, unknown> | null {
	try {
		const v: unknown = JSON.parse(args);
		return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/** 单个工具调用 → path + DiffSection + 统计；不符合口径返回 null */
function sectionFromTool(
	tool: UIToolCall,
): { path: string; section: DiffSection; added: number; removed: number } | null {
	const args = parseToolArgs(tool.args);
	const path = typeof args?.path === "string" && args.path.length > 0 ? args.path : null;
	if (!path) return null;
	if (tool.name === "edit") {
		if (!tool.diff) return null;
		const stat = patchStat(tool.diff);
		if (stat.added === 0 && stat.removed === 0) return null;
		return { path, section: { toolCallKey: tool.key, kind: "edit", patch: tool.diff }, ...stat };
	}
	// write：全量 + 行（无改前内容，口径差异已在 spec 确认）
	const content = typeof args?.content === "string" ? args.content : "";
	if (content.length === 0) return null;
	return {
		path,
		section: { toolCallKey: tool.key, kind: "write", content },
		added: content.split("\n").length,
		removed: 0,
	};
}

export function deriveTurnChanges(messages: UIMessage[]): TurnChanges[] {
	const turns: TurnChanges[] = [];
	let turnIndex = -1;
	let files = new Map<string, TurnFileChange>();

	const flush = (): void => {
		if (files.size === 0) return;
		const list = [...files.values()];
		turns.push({
			turnIndex,
			files: list,
			totalAdded: list.reduce((s, f) => s + f.added, 0),
			totalRemoved: list.reduce((s, f) => s + f.removed, 0),
		});
	};

	for (const m of messages) {
		if (m.kind === "user") {
			flush();
			turnIndex++;
			files = new Map();
			continue;
		}
		// 首条 user 之前的 assistant（理论上不存在）不计
		if (m.kind !== "assistant" || turnIndex < 0) continue;
		for (const tool of m.tools) {
			if (tool.state === "error" || !FILE_TOOL_NAMES.has(tool.name)) continue;
			const parsed = sectionFromTool(tool);
			if (!parsed) continue;
			const existing = files.get(parsed.path);
			if (existing) {
				existing.added += parsed.added;
				existing.removed += parsed.removed;
				existing.sections.push(parsed.section);
			} else {
				files.set(parsed.path, {
					path: parsed.path,
					added: parsed.added,
					removed: parsed.removed,
					sections: [parsed.section],
				});
			}
		}
	}
	flush();
	return turns;
}
