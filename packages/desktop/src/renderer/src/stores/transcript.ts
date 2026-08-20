import type { SessionEvent, PermissionRequest as SharedPermissionRequest, TodoItem } from "@percho/shared";
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
	SubagentRunUi,
	UIMessage,
	UIToolCall,
} from "./transcript-reducer";

/** 跨进程完整请求（含 kind/suggestDir）；App 订阅转发时缺省字段补齐 */
export interface PermissionRequest extends SharedPermissionRequest {}

export interface SessionEntry extends SessionTranscriptState {
	pendingPermissions: PermissionRequest[];
}

const EMPTY_ENTRY: SessionEntry = { ...emptyTranscript(), pendingPermissions: [] };

/** 空 todo 列表稳定引用（面板 selector 缺省用，禁内联新数组） */
export const EMPTY_TODOS: TodoItem[] = [];

interface TranscriptStore {
	bySession: Record<string, SessionEntry>;
	/** isActiveViewing：事件到达时该会话是否正被查看（活跃 tab 且 chat 视图），由调用方判定避免依赖 sessions store */
	applyEvent: (sessionId: string, event: SessionEvent, opts?: { isActiveViewing?: boolean }) => void;
	/** 乐观置 agent 运行状态（发送消息后立即置 true，失败/结束后置 false 修正） */
	markAgentActive: (sessionId: string, active: boolean) => void;
	/** 清除完成未读标记（切到该会话/回到 chat 视图时调用） */
	markCompletionSeen: (sessionId: string) => void;
	addPermission: (sessionId: string, req: PermissionRequest) => void;
	resolvePermission: (sessionId: string, requestId: string) => void;
	resetSession: (sessionId: string) => void;
	/** 打开历史会话时回放已有消息（不触发 reducer 事件流） */
	loadHistory: (sessionId: string, messages: UIMessage[]) => void;
	/** 直接设置排队中的 followUp（打开/切换会话时从 backend 拉初始值；运行中由 queue_update 事件驱动） */
	setFollowUpQueue: (sessionId: string, queue: string[]) => void;
	/** 打开会话时从 backend 恢复任务列表（compaction 后 UI 面板数据源；仅写 todos，不动消息） */
	loadTodos: (sessionId: string, todos: TodoItem[]) => void;
}

export const useTranscriptStore = create<TranscriptStore>((set) => ({
	bySession: {},
	applyEvent: (sessionId, event, opts) => {
		set((state) => {
			const current = state.bySession[sessionId];
			const prev = current ?? emptyTranscript();
			const next = reduceEvent(prev, event);
			// 完成未读：agentActive true→false 且当时未被查看 → 置标记；重新开工 → 清除
			let unseenCompletion = prev.unseenCompletion;
			if (next.agentActive) unseenCompletion = false;
			else if (prev.agentActive && !opts?.isActiveViewing) unseenCompletion = true;
			return {
				bySession: {
					...state.bySession,
					[sessionId]: {
						...next,
						unseenCompletion,
						pendingPermissions: current?.pendingPermissions ?? [],
					},
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
					// 乐观开工同时清未读；失败回滚 false 不算"完成"，不动未读标记
					[sessionId]: {
						...current,
						agentActive: active,
						unseenCompletion: active ? false : current.unseenCompletion,
					},
				},
			};
		});
	},
	markCompletionSeen: (sessionId) => {
		set((state) => {
			const current = state.bySession[sessionId];
			if (!current?.unseenCompletion) return state;
			return {
				bySession: {
					...state.bySession,
					[sessionId]: { ...current, unseenCompletion: false },
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
			const notices =
				current?.messages.filter((message) => message.kind === "system" && !message.compact) ?? [];
			return {
				bySession: {
					...state.bySession,
					[sessionId]: {
						messages: [...notices, ...messages],
						streaming: null,
						phase: "idle",
						agentActive: false,
						unseenCompletion: false,
						compacting: false,
						followUpQueue: current?.followUpQueue ?? [],
						// loadHistory 只换消息流（compaction 后对齐 pi 裁剪），todo 列表保留
						todos: current?.todos ?? [],
						pendingPermissions: current?.pendingPermissions ?? [],
					},
				},
			};
		});
	},
	setFollowUpQueue: (sessionId, queue) => {
		set((state) => {
			const current = state.bySession[sessionId];
			return {
				bySession: {
					...state.bySession,
					[sessionId]: {
						...(current ?? { ...EMPTY_ENTRY }),
						followUpQueue: queue,
					},
				},
			};
		});
	},
	loadTodos: (sessionId, todos) => {
		set((state) => {
			const current = state.bySession[sessionId];
			return {
				bySession: {
					...state.bySession,
					[sessionId]: {
						...(current ?? { ...EMPTY_ENTRY }),
						todos,
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
