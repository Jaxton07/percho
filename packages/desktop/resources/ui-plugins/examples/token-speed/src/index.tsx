import { useLanguage, useSessionsStore, useTurnSpeed } from "@percho/plugin-api";
import { memo } from "react";

/**
 * Token 速度 chip（随包示例）：
 * - useTurnSpeed(sessionId)：当前轮 Σ 输出 token ÷ Σ 实测生成耗时（逐条 LLM 消息，
 *   不含工具执行/排队/失败重试）；事件驱动刷新（assistant message_end/turn_end/agent_settled 等）
 * - sessionId 为 null（新会话页）或本轮无有效样本 → 返回 null → 自动隐藏（宁缺勿错）
 * - composer.footer 行内区域（ContextRing 旁）：宿主不包定位容器，chip 自身即交互子树
 */
export const TokenSpeed = memo(function TokenSpeed() {
	const lang = useLanguage();
	const sessionId = useSessionsStore((s) => s.activeSessionId);
	const speed = useTurnSpeed(sessionId);
	if (!speed) return null;

	const detail =
		lang === "zh"
			? `实际输出 ${speed.outputTokens} token · 生成耗时 ${(speed.durationMs / 1000).toFixed(1)}s · ${speed.samples} 条 LLM 消息（不含工具执行）`
			: `${speed.outputTokens} tokens output · ${(speed.durationMs / 1000).toFixed(1)}s generation · ${speed.samples} LLM messages (tool time excluded)`;

	return (
		<span
			className="inline-flex items-center gap-1 rounded-md bg-surface px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-ink-2"
			title={detail}
		>
			<span className="text-ink-dim">⚡</span>
			{formatSpeed(speed.speed)}
		</span>
	);
});

function formatSpeed(speed: number): string {
	return speed >= 100 ? String(Math.round(speed)) : speed.toFixed(1);
}
