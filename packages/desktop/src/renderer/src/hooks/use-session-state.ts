import type { AvailableModel } from "@percho/shared";
import { useSessionsStore } from "../stores/sessions";
import { useTranscriptStore } from "../stores/transcript";

/**
 * 当前生效模型的完整信息（D4 收拢点）：
 * 真实会话 = 会话覆写 ?? 全局默认；draft 页（`activeSessionId === null`）= draft 配置里的起步模型。
 * Composer（图片门控）/ ModelPicker / ThinkingPicker 三处共用，替代各自手写解析。
 */
export function useActiveModelInfo(): AvailableModel | undefined {
	return useSessionsStore((s) => {
		const sessionModel = s.sessions.find((x) => x.sessionId === s.activeSessionId)?.model;
		const effective =
			s.activeSessionId === null ? s.newSessionDraft?.model : (sessionModel ?? s.lastUsedModel);
		if (!effective) return undefined;
		return s.models.find((m) => m.provider === effective.provider && m.id === effective.modelId);
	});
}

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
