import { clampSidebarWidth, type PermissionMode, SIDEBAR_DEFAULT_WIDTH, type UiState } from "@percho/shared";
import { create } from "zustand";
import { getPi } from "../api";
import { toggleInList } from "../lib/toggle-in-list";

/** 应用级 UI 偏好（持久化在 ui-state.json，与主题/背景同源；主进程 normalize 负责旧文件缺省） */
interface UiPreferencesStore {
	/** 中央状态动画：任务运行时对话区中央显示放大 orb（z-20 文字层之上 + canvas 一体遮罩压文字）；与 Working/Thinking 行前小 orb 解耦，小 orb 恒显示 */
	centerOrbEnabled: boolean;
	/** 置顶会话（id，新置顶在前）：**v8 起就是顶栏胶囊的内容**（左栏只靠图钉标记，不改顺序） */
	pinnedSessions: string[];
	/** 按会话记住的权限模式（只存非 default；见 spec/permission-mode.md D7） */
	sessionPermissionModes: Record<string, PermissionMode>;
	/** 顶栏显隐（设置页开关，默认开）：关闭后导航全落在左侧栏 */
	/** 顶栏是否显示临时会话工作区胶囊（顶栏本身常驻；设置页「顶栏显示会话」） */
	barSessionsVisible: boolean;
	/** 左侧会话短线轨道开关（设置页，默认**关**）；与顶栏开关各自独立，两个都关则清空工作区 */
	sessionRailEnabled: boolean;
	/** 左侧栏收起（宽 0，彻底藏起；只有顶栏最左按钮能改，默认展开） */
	sidebarCollapsed: boolean;
	/**
	 * 左侧栏宽度（px）= **用户意图值**（拖拽的落点，越界已在写入时 clamp）。
	 * 它不是渲染宽：渲染宽 = 它再被「容器宽 - 聊天列最小宽」夹紧（`lib/sidebar-width.ts`），不回写这里。
	 */
	sidebarWidth: number;
	/** 左侧栏已展开的分组 key；含义由 `expandedGroupsTouched` 决定（见 shared UiState，空数组不再兼任「未操作」） */
	expandedGroups: string[];
	/** 展开态是否已被用户手动开合过（false = 走 Sidebar 的默认推断，true = 空数组合法表示全部折叠） */
	expandedGroupsTouched: boolean;
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
	/** 左侧会话轨道开关（关掉最后一处时由 workspace store 侧订阅清空工作区，见 session-workspace.ts） */
	setSessionRailEnabled: (enabled: boolean) => void;
	/** 收起 / 展开左侧栏（宽 240 ↔ 0） */
	toggleSidebarCollapsed: () => void;
	/**
	 * 拖动中的逐帧预览：只 `set` 内存、**不落盘**（每帧一次 IPC + 原子写会把写盘队列打爆）。
	 * 入参是用户意图值，越界在这里夹紧。落盘交 `commitSidebarWidth`（`pointerup` 调）。
	 */
	previewSidebarWidth: (width: number) => void;
	/** 把当前 `sidebarWidth` 落盘一次（拖拽收尾调；幂等，未拖动时调也没坏处） */
	commitSidebarWidth: () => void;
	/** 左侧栏开合一个分组（由 useExpandedGroups 算好新的展开集）：**同时置 touched 位**，
	 *  空数组合法表示「用户把最后一组也折了」（旧版空数组只能表示「没操作过」） */
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
	sessionRailEnabled: false,
	sidebarCollapsed: false,
	sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
	/** 左侧栏展开分组的记录（`setExpandedGroups` 同时置 touched 位） */
	expandedGroups: [],
	expandedGroupsTouched: false,
	/** 置顶项目 cwd（新置顶在前，决定左侧栏项目区排序） */
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
			sessionRailEnabled: saved?.sessionRailEnabled ?? false,
			sidebarCollapsed: saved?.sidebarCollapsed ?? false,
			sidebarWidth: clampSidebarWidth(saved?.sidebarWidth),
			expandedGroups: saved?.expandedGroups ?? [],
			expandedGroupsTouched: saved?.expandedGroupsTouched ?? false,
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

	setSessionRailEnabled: (enabled) => {
		set({ sessionRailEnabled: enabled });
		persistPatch({ sessionRailEnabled: enabled });
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

	previewSidebarWidth: (width) => {
		const next = clampSidebarWidth(width);
		// 同值短路：拖动中每帧 set 同一个值只会白白触发一次渲染（订阅方拿到的 state 对象会变）
		if (next === get().sidebarWidth) return;
		set({ sidebarWidth: next });
	},

	commitSidebarWidth: () => {
		persistPatch({ sidebarWidth: get().sidebarWidth });
	},

	setExpandedGroups: (groups) => {
		// 一次 set + 一个补丁同时写两个字段：分开写会出现「记录已存但 touched 没存」的中间态（重启后语义反转）
		set({ expandedGroups: groups, expandedGroupsTouched: true });
		persistPatch({ expandedGroups: groups, expandedGroupsTouched: true });
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
}));
