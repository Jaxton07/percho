import type { TurnSpeedInfo } from "@percho/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { getExecutionApi } from "../environment-api";

/** 触发刷新的事件类型（流式 delta 类高频事件不刷新）；message_end 仅 assistant 消息产生速度样本 */
const REFRESH_EVENTS = new Set([
	"message_end",
	"turn_end",
	"agent_settled",
	"session_info_changed",
	"compaction_end",
]);

/**
 * 当前轮 token 生成速度 hook（事件驱动刷新）：返回本轮 { outputTokens, durationMs, speed, samples }。
 * sessionId 为 null（新会话页，后端还没有这个会话）时返回 null；本轮无有效样本时后端返回 null
 * （宁缺勿错：不显示假速度）。token-speed 插件与宿主 host API 共用。
 */
export function useTurnSpeed(sessionId: string | null): TurnSpeedInfo | null {
	const [speed, setSpeed] = useState<TurnSpeedInfo | null>(null);
	// 取消标志：sessionId 切换后旧请求的迟到回写不再生效（防闪旧会话数据）
	const generationRef = useRef(0);

	const refresh = useCallback(async () => {
		const generation = ++generationRef.current;
		// 新会话页（null）在后端还不存在，无速度可查
		if (!sessionId) {
			setSpeed(null);
			return;
		}
		try {
			const next = await getExecutionApi(sessionId).getTurnSpeed({ sessionId });
			if (generation === generationRef.current) setSpeed(next);
		} catch {
			if (generation === generationRef.current) setSpeed(null);
		}
	}, [sessionId]);

	useEffect(() => {
		void refresh();
		return () => {
			generationRef.current += 1;
		};
	}, [refresh]);

	// 事件驱动刷新：assistant 消息落地/轮结束/会话信息变更取一次
	useEffect(() => {
		if (!sessionId) return;
		const off = getExecutionApi(sessionId).onEvent(({ sessionId: sid, event }) => {
			if (sid !== sessionId || !REFRESH_EVENTS.has(event.type)) return;
			if (event.type === "message_end" && event.message.role !== "assistant") return;
			void refresh();
		});
		return off;
	}, [sessionId, refresh]);

	return speed;
}
