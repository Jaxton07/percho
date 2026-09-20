import type { PermissionMode, UiState } from "@percho/shared";
import { create } from "zustand";
import { getPi } from "../api";
import { toggleInList } from "../lib/sidebar-groups";

/** 应用级 UI 偏好（持久化在 ui-state.json，与主题/背景同源；主进程 normalize 负责旧文件缺省） */
interface UiPreferencesStore {
	/** 中央状态动画：任务运行时对话区中央显示放大 orb（z-20 文字层之上 + canvas 一体遮罩压文字）；与 Working/Thinking 行前小 orb 解耦，小 orb 恒显示 */
	centerOrbEnabled: boolean;
	/** 置顶会话（id，新置顶在前）：**v8 起就是顶栏胶囊的内容**（左栏只靠图钉标记，不改顺序） */
	pinnedSessions: string[];
	/** 按会话记住的权限模式（只存非 default；见 spec/permission-mode.md D7） */
	sessionPermissionModes: Record<string, PermissionMode>;
	/** 顶栏显隐（设置页开关，默认开）：关闭后导航全落在左侧栏 */
	/** 顶栏是否显示置顶会话胶囊（顶栏本身常驻；设置页「顶栏显示会话」） */
	barSessionsVisible: boolean;
	/** 左侧栏收起（宽 0，彻底藏起；只有顶栏最左按钮能改，默认展开） */
	sidebarCollapsed: boolean;
	/** 左侧栏已展开的分组 key；空数组 = 用户没手动开合过（走 Sidebar 的默认推断，见 lib/sidebar-groups） */
	expandedGroups: string[];
	/** 置顶项目 cwd（新置顶在前，决定左侧栏项目区排序） */
	pinnedProjects: string[];
	/** 上次使用的项目目录（重启后启动页预填；只记目录、不恢复会话）；null = 未记过 */
	lastCwd: string | null;
	/** 启动时从 ui-state.json 恢复（main.tsx 在 render 前 await，避免开关状态闪现） */
	init: () => Promise<void>;
	setCenterOrbEnabled: (enabled: boolean) => void;
	/** 置顶 / 取消置顶（新置顶排最左） */
	togglePin: (sessionId: string) => void;
	setBarSessionsVisible: (visible: boolean) => void;
	/** 收起 / 展开左侧栏（宽 240 ↔ 0） */
	toggleSidebarCollapsed: () => void;
	/** 覆盖左侧栏展开分组（开合一个组的起点由 useExpandedGroups 算好，见 lib/sidebar-groups） */
	setExpandedGroups: (groups: string[]) => void;
	/** 置顶 / 取消置顶项目（新置顶排最前） */
	toggleProjectPin: (cwd: string) => void;
	/** 清理单个会话的置顶（删除会话时调用；不在列表里则无副作用） */
	unpin: (sessionId: string) => void;
	/**
	 * 记住会话的权限模式（D7）：非 `default` 写入（同值短路），传 `default` 则删键。
	 * 调用点：`setSessionPermissionMode` **IPC 成功后**（失败回滚不记）。
	 */
	rememberPermissionMode: (sessionId: string, mode: PermissionMode) => void;
	/** 删除会话时清掉它的权限模式记录（与 `unpin` 并列） */
	forgetPermissionMode: (sessionId: string) => void;
	/** 拖动排序顶栏胶囊（v8）：改的也是 pinnedSessions 顺序，不动 tabs.json */
	reorderPinned: (fromId: string, toId: string) => void;
	/** 记住上次项目目录（切会话/打开会话/建会话时由 sessions store 调；同值不重复写盘） */
	setLastCwd: (cwd: string | null) => void;
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
	sessionPermissionModes: {},
	barSessionsVisible: true,
	sidebarCollapsed: false,
	expandedGroups: [],
	pinnedProjects: [],
	lastCwd: null,

	init: async () => {
		const saved = await getPi()
			.loadUiState()
			.catch(() => null);
		set({
			centerOrbEnabled: saved?.centerOrbEnabled ?? false,
			pinnedSessions: saved?.pinnedSessions ?? [],
			sessionPermissionModes: saved?.sessionPermissionModes ?? {},
			barSessionsVisible: saved?.barSessionsVisible ?? true,
			sidebarCollapsed: saved?.sidebarCollapsed ?? false,
			expandedGroups: saved?.expandedGroups ?? [],
			pinnedProjects: saved?.pinnedProjects ?? [],
			lastCwd: saved?.lastCwd ?? null,
		});
	},

	setCenterOrbEnabled: (enabled) => {
		set({ centerOrbEnabled: enabled });
		persistPatch({ centerOrbEnabled: enabled });
	},

	setBarSessionsVisible: (visible) => {
		set({ barSessionsVisible: visible });
		persistPatch({ barSessionsVisible: visible });
	},

	setLastCwd: (cwd) => {
		if (get().lastCwd === cwd) return;
		set({ lastCwd: cwd });
		persistPatch({ lastCwd: cwd });
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

	rememberPermissionMode: (sessionId, mode) => {
		const current = get().sessionPermissionModes;
		if (mode === "default") {
			if (!(sessionId in current)) return;
			const next = { ...current };
			delete next[sessionId];
			set({ sessionPermissionModes: next });
			persistPatch({ sessionPermissionModes: next });
			return;
		}
		if (current[sessionId] === mode) return;
		const next = { ...current, [sessionId]: mode };
		set({ sessionPermissionModes: next });
		persistPatch({ sessionPermissionModes: next });
	},

	forgetPermissionMode: (sessionId) => {
		const current = get().sessionPermissionModes;
		if (!(sessionId in current)) return;
		const next = { ...current };
		delete next[sessionId];
		set({ sessionPermissionModes: next });
		persistPatch({ sessionPermissionModes: next });
	},

	/**
	 * 拖拽排序（v8）：顶栏胶囊内容 = 置顶表，所以拖动改的是 pinnedSessions 顺序，
	 * **不再**改 tabs.json（tabs 顺序变成纯打开历史，与顶栏无关）。
	 */
	reorderPinned: (fromId, toId) => {
		const current = get().pinnedSessions;
		const from = current.indexOf(fromId);
		const to = current.indexOf(toId);
		if (from < 0 || to < 0 || from === to) return;
		const next = [...current];
		const [moved] = next.splice(from, 1);
		if (!moved) return;
		next.splice(to, 0, moved);
		set({ pinnedSessions: next });
		persistPatch({ pinnedSessions: next });
	},
}));
