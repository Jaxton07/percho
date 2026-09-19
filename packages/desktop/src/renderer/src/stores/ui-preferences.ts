import { create } from "zustand";
import { getPi } from "../api";

/** 应用级 UI 偏好（持久化在 ui-state.json，与主题/背景同源；主进程 normalize 负责旧文件缺省） */
interface UiPreferencesStore {
	/** 左侧会话轨道：聊天页左侧短线悬停展开标题，快速切换会话（默认关，顶栏胶囊不受影响） */
	sessionRailEnabled: boolean;
	/** 中央状态动画：任务运行时对话区中央显示放大 orb（z-20 文字层之上 + canvas 一体遮罩压文字）；与 Working/Thinking 行前小 orb 解耦，小 orb 恒显示 */
	centerOrbEnabled: boolean;
	/** 置顶会话（id，新置顶在前）：只影响本机展示顺序，不写会话文件、不同步 */
	pinnedSessions: string[];
	/** 会话列表位置：顶栏胶囊（默认）/ 对话页左上角悬浮面板（互斥，见 FloatingSessionList） */
	sessionListMode: "tabbar" | "floating";
	/** 启动时从 ui-state.json 恢复（main.tsx 在 render 前 await，避免开关状态闪现） */
	init: () => Promise<void>;
	setSessionRailEnabled: (enabled: boolean) => void;
	setCenterOrbEnabled: (enabled: boolean) => void;
	/** 置顶 / 取消置顶（新置顶排最左） */
	togglePin: (sessionId: string) => void;
	/** 切换会话列表位置（顶栏胶囊 ↔ 悬浮面板） */
	setSessionListMode: (mode: "tabbar" | "floating") => void;
	/** 清理单个会话的置顶（删除会话时调用；不在列表里则无副作用） */
	unpin: (sessionId: string) => void;
}

/** 持久化补丁（失败只记日志：偏好丢失不影响使用，弹 toast 反而更吵） */
function persist(pinnedSessions: string[]): void {
	getPi()
		.saveUiState({ state: { pinnedSessions } })
		.catch((error) => console.error("ui-state 持久化失败", error));
}

export const useUiPreferencesStore = create<UiPreferencesStore>((set, get) => ({
	sessionRailEnabled: false,
	centerOrbEnabled: false,
	pinnedSessions: [],
	sessionListMode: "tabbar",

	init: async () => {
		const saved = await getPi()
			.loadUiState()
			.catch(() => null);
		set({
			sessionRailEnabled: saved?.sessionRailEnabled ?? false,
			centerOrbEnabled: saved?.centerOrbEnabled ?? false,
			pinnedSessions: saved?.pinnedSessions ?? [],
			sessionListMode: saved?.sessionListMode ?? "tabbar",
		});
	},

	setSessionRailEnabled: (enabled) => {
		set({ sessionRailEnabled: enabled });
		getPi()
			.saveUiState({ state: { sessionRailEnabled: enabled } })
			.catch((error) => console.error("ui-state 持久化失败", error));
	},

	setCenterOrbEnabled: (enabled) => {
		set({ centerOrbEnabled: enabled });
		getPi()
			.saveUiState({ state: { centerOrbEnabled: enabled } })
			.catch((error) => console.error("ui-state 持久化失败", error));
	},

	setSessionListMode: (mode) => {
		set({ sessionListMode: mode });
		getPi()
			.saveUiState({ state: { sessionListMode: mode } })
			.catch((error) => console.error("ui-state 持久化失败", error));
	},

	togglePin: (sessionId) => {
		const current = get().pinnedSessions;
		const next = current.includes(sessionId)
			? current.filter((id) => id !== sessionId)
			: [sessionId, ...current];
		set({ pinnedSessions: next });
		persist(next);
	},

	unpin: (sessionId) => {
		const current = get().pinnedSessions;
		if (!current.includes(sessionId)) return;
		const next = current.filter((id) => id !== sessionId);
		set({ pinnedSessions: next });
		persist(next);
	},
}));
