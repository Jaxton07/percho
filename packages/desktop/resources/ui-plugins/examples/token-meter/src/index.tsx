import { useContextUsage, useSessionsStore } from "@percho/plugin-api";
import { memo } from "react";

/**
 * Token 迷你仪表盘（随包示例）：
 * - useContextUsage(sessionId)：事件驱动刷新（message_end/tool_execution_end/turn_end/…），
 *   sessionId 为 null/draft 时返回 null（自动隐藏）
 * - chat.corner.top-right 与 TodoPanel 同角：容器已预留 pt-12，贡献堆在面板下方
 */
export const TokenMeter = memo(function TokenMeter() {
	const sessionId = useSessionsStore((s) => s.activeSessionId);
	const usage = useContextUsage(sessionId);
	if (!usage || usage.percent == null) return null;

	const pct = Math.max(0, Math.min(100, usage.percent));
	const color = pct < 60 ? "bg-ink-dim" : pct < 85 ? "bg-amber-500" : "bg-red-500";
	const textColor = pct < 60 ? "text-ink-2" : pct < 85 ? "text-amber-600" : "text-red-600";

	return (
		<div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-1.5 shadow-soft">
			<div className="h-1.5 w-16 overflow-hidden rounded-full bg-border">
				<div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
			</div>
			<span className={`text-[11px] font-medium tabular-nums ${textColor}`}>{pct.toFixed(0)}%</span>
			<span className="text-[10px] text-ink-faint tabular-nums">
				{formatTokens(usage.tokens ?? 0)}/{formatTokens(usage.contextWindow)}
			</span>
		</div>
	);
});

function formatTokens(n: number): string {
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}
