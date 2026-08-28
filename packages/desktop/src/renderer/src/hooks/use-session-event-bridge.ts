import type { SessionEvent, TrustRequest } from "@percho/shared";
import { useEffect } from "react";
import { getPi } from "../api";
import { EventConflator } from "../stores/event-conflator";
import { useSessionsStore } from "../stores/sessions";
import { useTranscriptStore } from "../stores/transcript";
import { useUiStore } from "../stores/ui";

/**
 * 会话事件桥：把 main 转发的事件流接进 renderer stores（App 装配层专用 hook）。
 * 流式 delta 按帧合流（见 stores/event-conflator.ts）：store 提交频率 ≤ 1 次/帧，
 * 边界事件（message_start/end、toolcall_start/end、turn_end、agent_end…）先冲刷挂起增量
 * 再立即应用，顺序与逐条转发完全一致。isActiveViewing 在应用时刻取值：延迟至多一帧且
 * 该标记只在 agentActive 翻转的边界事件上生效（不经过合流），语义不变。
 */
export function useSessionEventBridge({ onTrustRequest }: { onTrustRequest: (req: TrustRequest) => void }): void {
	useEffect(() => {
		const pi = getPi();
		const conflator = new EventConflator({
			apply: (sessionId, event) => {
				useTranscriptStore.getState().applyEvent(sessionId, event, {
					// 正被查看（活跃 tab 且 chat 视图）的会话完成时不打未读标记
					isActiveViewing:
						useSessionsStore.getState().activeSessionId === sessionId &&
						useUiStore.getState().view === "chat",
				});
			},
		});
		const offEvent = pi.onEvent(({ sessionId, event }: { sessionId: string; event: SessionEvent }) => {
			if (event.type === "session_info_changed") {
				useSessionsStore.getState().updateSessionName(sessionId, event.name);
				return; // 会话名走 sessions store；reducer 对该类型本就无操作
			}
			conflator.push(sessionId, event);
		});
		const offPermission = pi.onPermissionRequest((req) => {
			useTranscriptStore.getState().addPermission(req.sessionId, req);
		});
		const offPermissionResolved = pi.onPermissionResolved((result) => {
			useTranscriptStore.getState().resolvePermission(result.sessionId, result.requestId);
		});
		const offTrust = pi.onTrustRequest(onTrustRequest);
		return () => {
			offEvent();
			conflator.dispose();
			offPermission();
			offPermissionResolved();
			offTrust();
		};
	}, [onTrustRequest]);
}
