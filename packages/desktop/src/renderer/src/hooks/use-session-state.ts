import { useSessionsStore } from "../stores/sessions";
import { useTranscriptStore } from "../stores/transcript";

/** 活跃会话是否只读（subagent 产物检视）；无会话 = false */
export function useSessionReadOnly(): boolean {
	return useSessionsStore(
		(s) => s.sessions.find((x) => x.sessionId === s.activeSessionId)?.readOnly === true,
	);
}

/** 会话忙碌（agent 运行中或压缩中）：fork/撤回/发送类操作的禁用依据 */
export function useSessionBusy(sessionId: string | null): boolean {
	return useTranscriptStore((s) => {
		if (!sessionId) return false;
		const entry = s.bySession[sessionId];
		return entry?.agentActive === true || entry?.compacting === true;
	});
}
