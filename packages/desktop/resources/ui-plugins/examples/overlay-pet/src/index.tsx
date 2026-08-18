import { useSessionsStore, useTranscriptStore } from "@percho/plugin-api";
import { memo } from "react";

/**
 * 悬浮桌宠（随包示例）：
 * - contribution 无 props，数据经 host API stores 自取（store 连接型）
 * - 常驻动画只走 CSS transform（合成器线程），prefers-reduced-motion 退化
 * - 容器 pointer-events-none，交互子树自己开 pointer-events-auto（这里开在宠物本体上）
 */
const petCss = `
@keyframes pet-breathe {
	0%, 100% { transform: scale(1); }
	50% { transform: scale(1.14); }
}
.pet-breathe { animation: pet-breathe 2.4s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) {
	.pet-breathe { animation: none; }
}`;

export const Pet = memo(function Pet() {
	const activeSessionId = useSessionsStore((s) => s.activeSessionId);
	// agentActive 是 per-session 状态；无活跃会话按空闲处理
	const agentActive = useTranscriptStore((s) =>
		activeSessionId ? (s.bySession[activeSessionId]?.agentActive ?? false) : false,
	);
	return (
		<>
			<style>{petCss}</style>
			<div className="pointer-events-auto flex flex-col items-center gap-1.5">
				<div
					className={`flex h-12 w-12 items-center justify-center rounded-full border border-border bg-surface text-[20px] shadow-soft ${
						agentActive ? "pet-breathe" : ""
					}`}
				>
					🐾
				</div>
				<span className="rounded-full bg-surface px-2 py-0.5 text-[10px] text-ink-dim shadow-soft">
					{agentActive ? "working…" : "idle"}
				</span>
			</div>
		</>
	);
});
