import type { SessionEvent, TrustRequest } from "@percho/shared";
import { useEffect } from "react";
import { subscribeExecutionEnvironments } from "../environment-api";
import { useDraftStore, withDraftText } from "../stores/drafts";
import { EventConflator } from "../stores/event-conflator";
import { acceptInteractionEvent, useInteractionStore } from "../stores/interactions";
import { useProjectsStore } from "../stores/projects";
import { acceptSessionEvent, onSessionBoundaryReset } from "../stores/session-event-boundary";
import { retrySessionHistory } from "../stores/session-history";
import { useSessionsStore } from "../stores/sessions";
import { pushExtensionToast } from "../stores/toasts";
import { useTranscriptStore } from "../stores/transcript";

/**
 * 会话事件桥：把 main 转发的事件流接进 renderer stores（App 装配层专用 hook）。
 * 流式 delta 按帧合流（见 stores/event-conflator.ts）：store 提交频率 ≤ 1 次/帧，
 * 边界事件（message_start/end、toolcall_start/end、turn_end、agent_end…）先冲刷挂起增量
 * 再立即应用，顺序与逐条转发完全一致。isActiveViewing 在应用时刻取值：延迟至多一帧且
 * 该标记只在 agentActive 翻转的边界事件上生效（不经过合流），语义不变。
 */
export function useSessionEventBridge({
	onTrustRequest,
}: {
	onTrustRequest: (req: TrustRequest) => void;
}): void {
	useEffect(() => {
		const conflator = new EventConflator({
			apply: (sessionId, event) => {
				useTranscriptStore.getState().applyEvent(sessionId, event, {
					// 正被查看（= 当前活跃 tab）的会话完成时不打未读标记
					isActiveViewing: useSessionsStore.getState().activeSessionId === sessionId,
				});
				if (event.type === "agent_settled") void retrySessionHistory(sessionId);
			},
		});
		const offBoundary = onSessionBoundaryReset((sessionId) => conflator.discard(sessionId));
		const offEnvironments = subscribeExecutionEnvironments((pi, environment) => {
			const offEvent = pi.onEvent(
				({ sessionId, event, sequence }: { sessionId: string; event: SessionEvent; sequence?: number }) => {
					acceptSessionEvent(sessionId, sequence, event, () => {
						if (event.type === "session_info_changed") {
							useSessionsStore.getState().updateSessionName(sessionId, event.name);
							// 新会话先以「未命名」meta 写穿进目录，首条消息随后才触发自动命名。
							// 目录也必须同步，否则 GC 卸载内存项后，左栏会退回 cwd 末级名（如 percho）。
							useProjectsStore.getState().applySessionName(sessionId, event.name);
							return; // 会话名走 sessions + projects 两份投影；reducer 对该类型本就无操作
						}
						conflator.push(sessionId, event);
					});
				},
			);
			const offPermission = pi.onPermissionRequest((req) => {
				acceptInteractionEvent(environment, req.revision, req, () => {
					useTranscriptStore.getState().addPermission(req.sessionId, req);
				});
			});
			const offPermissionResolved = pi.onPermissionResolved((result) => {
				acceptInteractionEvent(environment, result.revision, result, () => {
					useTranscriptStore.getState().resolvePermission(result.sessionId, result.requestId);
				});
			});
			// 扩展对话框（issue #45）：入队/撤卡 + notify→Toast + 预填→草稿（来源带一次性提示）
			const offDialogRequest = pi.onExtensionDialogRequest((req) => {
				acceptInteractionEvent(environment, req.revision, req, () => {
					useTranscriptStore.getState().addExtensionDialog(req.sessionId, req);
				});
			});
			const offDialogResolved = pi.onExtensionDialogResolved((result) => {
				acceptInteractionEvent(environment, result.revision, result, () => {
					useTranscriptStore.getState().resolveExtensionDialog(result.sessionId, result.requestId);
				});
			});
			const offNotify = pi.onExtensionNotify((event) => {
				pushExtensionToast(event.level, event.message, event.extensionPath || undefined);
			});
			const offEditorText = pi.onExtensionEditorText((event) => {
				useDraftStore.getState().updateDraft(event.sessionId, (d) => withDraftText(d, event.text));
				useTranscriptStore.getState().markExtensionPrefill(event.sessionId, event.source ?? "");
			});
			const offTrust = pi.onTrustRequest((req) =>
				acceptInteractionEvent(environment, req.revision, req, () => onTrustRequest(req)),
			);
			const offTrustResolved = pi.onTrustResolved((result) =>
				acceptInteractionEvent(environment, result.revision, result, () =>
					useInteractionStore.getState().removeTrust(result.requestId),
				),
			);
			return () => {
				offEvent();
				offPermission();
				offPermissionResolved();
				offDialogRequest();
				offDialogResolved();
				offNotify();
				offEditorText();
				offTrust();
				offTrustResolved();
			};
		});
		return () => {
			offBoundary();
			offEnvironments();
			conflator.dispose();
		};
	}, [onTrustRequest]);
}
