import type { ContextUsageInfo } from "@pi-desktop/shared";
import { useCallback, useEffect, useState } from "react";
import { getPi } from "../../api";
import { useSessionsStore } from "../../stores/sessions";
import { selectTranscript, useTranscriptStore } from "../../stores/transcript";

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

/** 上下文使用圆环：加号旁的小进度环，hover 显示 tokens / 窗口 / 百分比；会话无消息时隐藏（新会话的基线占用不展示） */
export function ContextRing() {
	const activeSessionId = useSessionsStore((s) => s.activeSessionId);
	const hasMessages = useTranscriptStore((s) => selectTranscript(s, activeSessionId).messages.length > 0);
	const [usage, setUsage] = useState<ContextUsageInfo | null>(null);

	const refresh = useCallback(async () => {
		if (!activeSessionId) {
			setUsage(null);
			return;
		}
		try {
			setUsage(await getPi().getContextUsage(activeSessionId));
		} catch {
			setUsage(null);
		}
	}, [activeSessionId]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	// 事件驱动刷新：每轮结束/工具完成后取一次
	useEffect(() => {
		const off = getPi().onEvent(({ sessionId, event }) => {
			if (sessionId !== activeSessionId || !isRefreshEvent(event.type)) return;
			void refresh();
		});
		return off;
	}, [activeSessionId, refresh]);

	if (!usage || usage.percent == null || !hasMessages) return null;

	const pct = Math.max(0, Math.min(100, usage.percent));
	const color = pct < 60 ? "stroke-zinc-400" : pct < 85 ? "stroke-amber-500" : "stroke-red-500";
	const r = 7;
	const c = 2 * Math.PI * r;

	return (
		<div className="group relative -mb-1 flex h-7 items-center">
			<svg
				width="17"
				height="17"
				viewBox="0 0 20 20"
				className="-rotate-90"
				role="img"
				aria-label={`${usage.percent.toFixed(0)}%`}
			>
				<circle cx="10" cy="10" r={r} className="fill-none stroke-zinc-200" strokeWidth="2.5" />
				<circle
					cx="10"
					cy="10"
					r={r}
					className={`fill-none ${color} transition-colors`}
					strokeWidth="2.5"
					strokeLinecap="round"
					strokeDasharray={`${(pct / 100) * c} ${c}`}
				/>
			</svg>
			<div className="pointer-events-none absolute bottom-full left-1/2 mb-1.5 -translate-x-1/2 rounded-md border border-zinc-200 bg-white px-2 py-1 text-[11px] whitespace-nowrap text-zinc-600 opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
				{formatTokens(usage.tokens ?? 0)} / {formatTokens(usage.contextWindow)} tokens · {pct.toFixed(0)}%
			</div>
		</div>
	);
}

function formatTokens(n: number): string {
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}
