import { create } from "zustand";
import { getPi } from "../api";

/** 应用级 UI 偏好（持久化在 ui-state.json，与主题/背景同源；主进程 normalize 负责旧文件缺省） */
interface UiPreferencesStore {
	/** 左侧会话轨道：聊天页左侧短线悬停展开标题，快速切换会话（默认关，顶栏胶囊不受影响） */
	sessionRailEnabled: boolean;
	/** 中央状态动画：任务运行时对话区中央显示放大 orb（z-20 文字层之上 + canvas 一体遮罩压文字）；与 Working/Thinking 行前小 orb 解耦，小 orb 恒显示 */
	centerOrbEnabled: boolean;
	/** 启动时从 ui-state.json 恢复（main.tsx 在 render 前 await，避免开关状态闪现） */
	init: () => Promise<void>;
	setSessionRailEnabled: (enabled: boolean) => void;
	setCenterOrbEnabled: (enabled: boolean) => void;
}

export const useUiPreferencesStore = create<UiPreferencesStore>((set) => ({
	sessionRailEnabled: false,
	centerOrbEnabled: false,

	init: async () => {
		const saved = await getPi()
			.loadUiState()
			.catch(() => null);
		set({
			sessionRailEnabled: saved?.sessionRailEnabled ?? false,
			centerOrbEnabled: saved?.centerOrbEnabled ?? false,
		});
	},

	setSessionRailEnabled: (enabled) => {
		set({ sessionRailEnabled: enabled });
		getPi().saveUiState({ sessionRailEnabled: enabled }).catch((error) => console.error("ui-state 持久化失败", error));
	},

	setCenterOrbEnabled: (enabled) => {
		set({ centerOrbEnabled: enabled });
		getPi().saveUiState({ centerOrbEnabled: enabled }).catch((error) => console.error("ui-state 持久化失败", error));
	},
}));
