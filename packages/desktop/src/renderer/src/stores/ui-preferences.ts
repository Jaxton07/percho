import { create } from "zustand";
import { getPi } from "../api";

/** 应用级 UI 偏好（持久化在 ui-state.json，与主题/背景同源；主进程 normalize 负责旧文件缺省） */
interface UiPreferencesStore {
	/** 左侧会话轨道：聊天页左侧短线悬停展开标题，快速切换会话（默认关，顶栏胶囊不受影响） */
	sessionRailEnabled: boolean;
	/** 启动时从 ui-state.json 恢复（main.tsx 在 render 前 await，避免开关状态闪现） */
	init: () => Promise<void>;
	setSessionRailEnabled: (enabled: boolean) => void;
}

export const useUiPreferencesStore = create<UiPreferencesStore>((set) => ({
	sessionRailEnabled: false,

	init: async () => {
		const saved = await getPi()
			.loadUiState()
			.catch(() => null);
		set({ sessionRailEnabled: saved?.sessionRailEnabled ?? false });
	},

	setSessionRailEnabled: (enabled) => {
		set({ sessionRailEnabled: enabled });
		void getPi().saveUiState({ sessionRailEnabled: enabled });
	},
}));
