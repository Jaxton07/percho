import { type RefObject, useCallback, useEffect, useReducer, useRef } from "react";
import { RegionHost } from "../../plugins/RegionHost";
import { UI_REGIONS } from "../../plugins/slots";
import { useChannelTopics } from "../../stores/channel-subscriptions";
import { useSessionsStore } from "../../stores/sessions";
import { ChannelSubscriptionPill } from "./ChannelSubscriptionPill";
import {
	type ChannelPillPresence,
	HIDDEN_PRESENCE,
	presenceForSession,
	reduceChannelPill,
} from "./channel-pill-presence";
import { cornerStackLead } from "./corner-stack-layout";
import { useTodoAnchor } from "./use-todo-anchor";

/**
 * 聊天区右上角的**共用堆叠**（spec D2）：宿主自带的频道订阅胶囊 + `chat.corner.top-right` 插件贡献，
 * 排在同一个纵向 flex 容器里 —— 这样永远不可能与合规贡献重叠。
 *
 * 位置：宿主测量 TodoPanel 渲染根的实际底边（`useTodoAnchor`，命令式写 `style.top`），胶囊与贡献都随之下移；
 * 没有 Todo 时回到 `top-2`（= TodoPanel 原右上角），贡献在该情形下保留现状的 56px 基线（见 corner-stack-layout）。
 *
 * 胶囊的存在性由纯状态机（`channel-pill-presence`）管：退场期间 DOM 还在（保留退场文本）⇒ 贡献的位置也
 * 跟着胶囊的实际占位，直到收起结束再切回基线；**切会话硬重置**，旧会话的名字绝不串到新会话。
 */
export function CornerStack({ slotHostRef }: { slotHostRef: RefObject<HTMLElement | null> }) {
	const stackRef = useRef<HTMLDivElement | null>(null);
	const activeSessionId = useSessionsStore((s) => s.activeSessionId);
	const topics = useChannelTopics(activeSessionId);
	const [presence, dispatch] = useReducer(reduceChannelPill, HIDDEN_PRESENCE);
	const hasAnchor = useTodoAnchor({ slotHost: slotHostRef, stack: stackRef });

	// 会话切换与订阅变化都在这一个 effect 里处理：**先 reset 再 sync** 的顺序是确定的，
	// reset 保证旧会话的名字绝不串到新会话（不播退场动画），sync 再按新会话的订阅进/退场
	const sessionRef = useRef(activeSessionId);
	useEffect(() => {
		const switched = sessionRef.current !== activeSessionId;
		sessionRef.current = activeSessionId;
		if (switched) dispatch({ type: "reset", sessionId: activeSessionId });
		dispatch({ type: "sync", sessionId: activeSessionId, topics });
	}, [activeSessionId, topics]);

	const handleExitFinished = useCallback((token: number) => {
		dispatch({ type: "exitFinished", token });
	}, []);

	// 渲染层立刻按会话过滤：切会话那一帧就隐藏旧内容（不等 effect 重置），旧名字绝不会画到新会话上
	const visible = presenceForSession(presence, activeSessionId);
	const lead = cornerStackLead(hasAnchor, visible.mounted);
	return (
		<div
			ref={stackRef}
			data-corner-stack=""
			className="pointer-events-none absolute right-4 top-2 z-20 flex flex-col items-end gap-2"
		>
			<ChannelSubscriptionPill presence={visible} onExitFinished={handleExitFinished} />
			<div style={{ marginTop: lead === 0 ? undefined : lead }} className="pointer-events-none">
				<RegionHost region={UI_REGIONS.CornerTopRight} layout="flow" />
			</div>
		</div>
	);
}

/** 仅供测试/诊断：当前 presence 的形状（避免测试直接依赖 reducer 内部） */
export type { ChannelPillPresence };
