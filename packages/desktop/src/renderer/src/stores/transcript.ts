import type { AgentSessionEvent } from "@pi-desktop/shared";
import { create } from "zustand";
import {
	emptyTranscript,
	reduceEvent,
	type SessionTranscriptState,
	type UIMessage,
} from "./transcript-reducer";

export type {
	ActivityEntry,
	SessionPhase,
	StreamingState,
	UIMessage,
	UIToolCall,
} from "./transcript-reducer";

export interface PermissionRequest {
	id: string;
	sessionId: string;
	title: string;
	message: string;
}

export interface SessionEntry extends SessionTranscriptState {
	pendingPermissions: PermissionRequest[];
}

const EMPTY_ENTRY: SessionEntry = { ...emptyTranscript(), pendingPermissions: [] };

interface TranscriptStore {
	bySession: Record<string, SessionEntry>;
	applyEvent: (sessionId: string, event: AgentSessionEvent) => void;
	/** 乐观置 agent 运行状态（发送消息后立即置 true，失败/结束后置 false 修正） */
	markAgentActive: (sessionId: string, active: boolean) => void;
	addPermission: (sessionId: string, req: PermissionRequest) => void;
	resolvePermission: (sessionId: string, requestId: string) => void;
	resetSession: (sessionId: string) => void;
	/** 打开历史会话时回放已有消息（不触发 reducer 事件流） */
	loadHistory: (sessionId: string, messages: UIMessage[]) => void;
}

export const useTranscriptStore = create<TranscriptStore>((set) => ({
	bySession: {},
	applyEvent: (sessionId, event) => {
		set((state) => {
			const current = state.bySession[sessionId];
			const next = reduceEvent(current ?? emptyTranscript(), event);
			return {
				bySession: {
					...state.bySession,
					[sessionId]: { ...next, pendingPermissions: current?.pendingPermissions ?? [] },
				},
			};
		});
	},
	markAgentActive: (sessionId, active) => {
		set((state) => {
			const current = state.bySession[sessionId];
			if (!current) return state;
			return {
				bySession: {
					...state.bySession,
					[sessionId]: { ...current, agentActive: active },
				},
			};
		});
	},
	addPermission: (sessionId, req) => {
		set((state) => {
			const current = state.bySession[sessionId];
			return {
				bySession: {
					...state.bySession,
					[sessionId]: {
						...(current ?? emptyTranscript()),
						pendingPermissions: [...(current?.pendingPermissions ?? []), req],
						phase: "awaiting_permission",
					},
				},
			};
		});
	},
	resolvePermission: (sessionId, requestId) => {
		set((state) => {
			const current = state.bySession[sessionId];
			if (!current) return state;
			const pendingPermissions = current.pendingPermissions.filter((p) => p.id !== requestId);
			return {
				bySession: {
					...state.bySession,
					[sessionId]: { ...current, pendingPermissions },
				},
			};
		});
	},
	resetSession: (sessionId) => {
		set((state) => ({
			bySession: { ...state.bySession, [sessionId]: { ...emptyTranscript(), pendingPermissions: [] } },
		}));
	},
	loadHistory: (sessionId, messages) => {
		set((state) => {
			const current = state.bySession[sessionId];
			return {
				bySession: {
					...state.bySession,
					[sessionId]: {
						messages,
						streaming: null,
						phase: "idle",
						agentActive: false,
						pendingPermissions: current?.pendingPermissions ?? [],
					},
				},
			};
		});
	},
}));

/** 读取某会话的 transcript（不存在时返回共享空态，引用稳定避免重渲染循环） */
export function selectTranscript(state: TranscriptStore, sessionId: string | null): SessionEntry {
	if (!sessionId) return EMPTY_ENTRY;
	return state.bySession[sessionId] ?? EMPTY_ENTRY;
}
