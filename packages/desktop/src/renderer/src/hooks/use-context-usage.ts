import type { ContextUsageInfo } from "@percho/shared";
import { useCallback, useEffect, useState } from "react";
import { getPi } from "../api";
import { isDraftSessionId } from "../stores/sessions";

/** 触发刷新的事件类型（流式 delta 类高频事件不刷新） */
const REFRESH_EVENTS = new Set([
	"message_end",
	"tool_execution_end",
	"turn_end",
	"agent_settled",
	"compaction_end",
	"session_info_changed",
]);

/** 刷新事件类型集合的类型收窄 */
function isRefreshEvent(type: string): boolean {
	return REFRESH_EVENTS.has(type);
}

/**
 * 上下文使用量 hook（事件驱动刷新）：给定会话 id，返回 { tokens, contextWindow, percent }。
 * sessionId 为 null / draft（后端无此会话）时返回 null。ContextRing 与插件 host API 共用，
 * 抽自 ContextRing（行为零变化）。
 */
export function useContextUsage(sessionId: string | null): ContextUsageInfo | null {
	const [usage, setUsage] = useState<ContextUsageInfo | null>(null);

	const refresh = useCallback(async () => {
		// draft 在后端不存在，无上下文用量可查
		if (!sessionId || isDraftSessionId(sessionId)) {
			setUsage(null);
			return;
		}
		try {
			setUsage(await getPi().getContextUsage(sessionId));
		} catch {
			setUsage(null);
		}
	}, [sessionId]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	// 事件驱动刷新：每轮结束/工具完成后取一次
	useEffect(() => {
		const off = getPi().onEvent(({ sessionId: sid, event }) => {
			if (sid !== sessionId || !isRefreshEvent(event.type)) return;
			void refresh();
		});
		return off;
	}, [sessionId, refresh]);

	return usage;
}
