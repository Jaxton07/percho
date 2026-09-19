import type { UiState } from "@percho/shared";
import { create } from "zustand";
import { getPi } from "../api";
import { toggleInList } from "../lib/sidebar-groups";

/** 应用级 UI 偏好（持久化在 ui-state.json，与主题/背景同源；主进程 normalize 负责旧文件缺省） */
interface UiPreferencesStore {
	/** 中央状态动画：任务运行时对话区中央显示放大 orb（z-20 文字层之上 + canvas 一体遮罩压文字）；与 Working/Thinking 行前小 orb 解耦，小 orb 恒显示 */
	centerOrbEnabled: boolean;
	/** 置顶会话（id，新置顶在前）：只影响本机展示顺序，不写会话文件、不同步 */
	pinnedSessions: string[];
	/** 顶栏显隐（设置页开关，默认开）：关闭后导航全落在左侧栏 */
	topBarVisible: boolean;
	/** 左侧栏收起（宽 0，彻底藏起；只有顶栏最左按钮能改，默认展开） */
	sidebarCollapsed: boolean;
	/** 左侧栏已展开的分组 key；空数组 = 用户没手动开合过（走 Sidebar 的默认推断，见 lib/sidebar-groups） */
	expandedGroups: string[];
	/** 置顶项目 cwd（新置顶在前，决定左侧栏项目区排序） */
	pinnedProjects: string[];
	/** 启动时从 ui-state.json 恢复（main.tsx 在 render 前 await，避免开关状态闪现） */
	init: () => Promise<void>;
	setCenterOrbEnabled: (enabled: boolean) => void;
	/** 置顶 / 取消置顶（新置顶排最左） */
	togglePin: (sessionId: string) => void;
	setTopBarVisible: (visible: boolean) => void;
	/** 收起 / 展开左侧栏（宽 240 ↔ 0） */
	toggleSidebarCollapsed: () => void;
	/** 覆盖左侧栏展开分组（开合一个组的起点由 useExpandedGroups 算好，见 lib/sidebar-groups） */
	setExpandedGroups: (groups: string[]) => void;
	/** 置顶 / 取消置顶项目（新置顶排最前） */
	toggleProjectPin: (cwd: string) => void;
	/** 清理单个会话的置顶（删除会话时调用；不在列表里则无副作用） */
	unpin: (sessionId: string) => void;
}

/** 持久化补丁（失败只记日志：偏好丢失不影响使用，弹 toast 反而更吵） */
function persistPatch(patch: Partial<UiState>): void {
	getPi()
		.saveUiState({ state: patch })
		.catch((error) => console.error("ui-state 持久化失败", error));
}

export const useUiPreferencesStore = create<UiPreferencesStore>((set, get) => ({
	centerOrbEnabled: false,
	pinnedSessions: [],
	topBarVisible: true,
	sidebarCollapsed: false,
	expandedGroups: [],
	pinnedProjects: [],

	init: async () => {
		const saved = await getPi()
			.loadUiState()
			.catch(() => null);
		set({
			centerOrbEnabled: saved?.centerOrbEnabled ?? false,
			pinnedSessions: saved?.pinnedSessions ?? [],
			topBarVisible: saved?.topBarVisible ?? true,
			sidebarCollapsed: saved?.sidebarCollapsed ?? false,
			expandedGroups: saved?.expandedGroups ?? [],
			pinnedProjects: saved?.pinnedProjects ?? [],
		});
	},

	setCenterOrbEnabled: (enabled) => {
		set({ centerOrbEnabled: enabled });
		persistPatch({ centerOrbEnabled: enabled });
	},

	setTopBarVisible: (visible) => {
		set({ topBarVisible: visible });
		persistPatch({ topBarVisible: visible });
	},

	toggleSidebarCollapsed: () => {
		const collapsed = !get().sidebarCollapsed;
		set({ sidebarCollapsed: collapsed });
		persistPatch({ sidebarCollapsed: collapsed });
	},

	setExpandedGroups: (groups) => {
		set({ expandedGroups: groups });
		persistPatch({ expandedGroups: groups });
	},

	togglePin: (sessionId) => {
		const next = toggleInList(get().pinnedSessions, sessionId);
		set({ pinnedSessions: next });
		persistPatch({ pinnedSessions: next });
	},

	toggleProjectPin: (cwd) => {
		const next = toggleInList(get().pinnedProjects, cwd);
		set({ pinnedProjects: next });
		persistPatch({ pinnedProjects: next });
	},

	unpin: (sessionId) => {
		const current = get().pinnedSessions;
		if (!current.includes(sessionId)) return;
		const next = current.filter((id) => id !== sessionId);
		set({ pinnedSessions: next });
		persistPatch({ pinnedSessions: next });
	},
}));
