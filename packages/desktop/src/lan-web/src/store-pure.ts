import {
	emptyTranscript,
	type LanSessionBrief,
	type LanSessionView,
	type LanSnapshot,
	type LanSseFrame,
	messagesToUIMessages,
	type PermissionRequest,
	reduceEvent,
	type SessionTranscriptState,
} from "@percho/shared";

/**
 * lan-web 数据层纯函数：snapshot 种子 + SSE 帧迁移，驱动 shared transcript reducer
 * （与桌面端同一份）。与 EventSource 接线（store.ts）分离，可直接单测。
 */

export type ConnStatus = "token" | "connecting" | "connected" | "reconnecting";

export interface LanAppState {
	token: string;
	status: ConnStatus;
	remoteControl: boolean;
	list: LanSessionBrief[];
	views: Record<string, LanSessionView>;
	transcripts: Record<string, SessionTranscriptState>;
	/** 每会话消息是否被尾部 cap 截断（snapshot truncated）。 */
	truncated: Record<string, boolean>;
	/** 未决权限请求（含 requestId；perm/perm_resolved 帧驱动）。 */
	pendingPerms: Record<string, PermissionRequest[]>;
	/** 当前选中的会话（null = 会话列表页）。 */
	selected: string | null;
	/** 最近一次快照的服务端帧序号（event 帧去重边界）。 */
	snapshotSeq: number;
	/** 快照种子是否已完成（完成前到达的帧由接线层缓冲）。 */
	seeded: boolean;
}

export const initialLanState: LanAppState = {
	token: "",
	status: "token",
	remoteControl: false,
	list: [],
	views: {},
	transcripts: {},
	truncated: {},
	pendingPerms: {},
	selected: null,
	snapshotSeq: 0,
	seeded: false,
};

/** snapshot → 状态种子（幂等；重连重拉即整体重置自愈）。 */
export function seedSessions(state: LanAppState, snap: LanSnapshot): Partial<LanAppState> {
	const views: Record<string, LanSessionView> = {};
	for (const view of snap.views) views[view.sessionId] = view;
	const transcripts: Record<string, SessionTranscriptState> = {};
	const truncated: Record<string, boolean> = {};
	for (const entry of snap.transcripts) {
		const view = views[entry.sessionId];
		transcripts[entry.sessionId] = {
			...emptyTranscript(),
			messages: messagesToUIMessages(entry.messages),
			agentActive: view?.agentActive ?? false,
			compacting: view?.compacting ?? false,
			todos: view?.todos ?? [],
		};
		truncated[entry.sessionId] = entry.truncated;
	}
	// 保留 selected（仍存在的话），否则回落到列表页
	const selected =
		state.selected && (views[state.selected] || snap.list.some((s) => s.sessionId === state.selected))
			? state.selected
			: null;
	return {
		list: snap.list,
		views,
		transcripts,
		truncated,
		selected,
		snapshotSeq: snap.snapshotSeq,
		remoteControl: snap.remoteControl,
		seeded: true,
	};
}

/** SSE 帧 → 状态迁移（event 帧带 seq 去重；view/list 全量幂等）。 */
export function applyFrame(state: LanAppState, frame: LanSseFrame): Partial<LanAppState> {
	switch (frame.event) {
		case "hello":
			return {};
		case "list":
			return { list: frame.data.list };
		case "view": {
			const { sessionId, view } = frame.data;
			const prev = state.transcripts[sessionId];
			// view 帧携带状态位；活跃会话的 transcript 同步状态位/todos
			const transcripts = prev
				? {
						...state.transcripts,
						[sessionId]: {
							...prev,
							agentActive: view.agentActive,
							compacting: view.compacting,
							todos: view.todos,
						},
					}
				: state.transcripts;
			return { views: { ...state.views, [sessionId]: view }, transcripts };
		}
		case "event": {
			const { sessionId, event, seq } = frame.data;
			// 快照去重边界：效果已含在快照种子内
			if (seq <= state.snapshotSeq) return {};
			const prev = state.transcripts[sessionId] ?? emptyTranscript();
			const next = reduceEvent(prev, event);
			if (next === prev && state.transcripts[sessionId]) return {};
			return { transcripts: { ...state.transcripts, [sessionId]: next } };
		}
		case "perm": {
			const { sessionId, request } = frame.data;
			const existing = state.pendingPerms[sessionId] ?? [];
			if (existing.some((r) => r.id === request.id)) return {};
			return { pendingPerms: { ...state.pendingPerms, [sessionId]: [...existing, request] } };
		}
		case "perm_resolved": {
			const { sessionId, requestId } = frame.data;
			const existing = state.pendingPerms[sessionId];
			if (!existing) return {};
			return {
				pendingPerms: {
					...state.pendingPerms,
					[sessionId]: existing.filter((r) => r.id !== requestId),
				},
			};
		}
	}
}
