import type { SessionMeta } from "@percho/shared";
import { create } from "zustand";
import { getPi } from "../api";
import { initDailyDir, isDailyCwd } from "../lib/daily";
import { partitionSessionsByPin, useSessionsStore } from "./sessions";
import { useUiPreferencesStore } from "./ui-preferences";

const ADDED_KEY = "pi-desktop.projects";

function loadAddedProjects(): string[] {
	try {
		const raw = localStorage.getItem(ADDED_KEY);
		const parsed = raw ? (JSON.parse(raw) as unknown) : [];
		return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
	} catch {
		return [];
	}
}

export interface ProjectEntry {
	cwd: string;
	/** 目录名（展示用） */
	name: string;
	sessionCount: number;
	/** 该项目下会话的最后活动时间 */
	lastActive: number;
	/** 手动添加过的项目在 addedProjects 中的下标（添加时间序；未手动添加为 -1），排序用 */
	addedIndex: number;
}

interface ProjectsStore {
	/**
	 * **会话目录**（跨项目）：存在性的唯一来源。内容 = 上次全量对账的磁盘历史 ∪ 本进程经手过的会话
	 * （新建/打开/fork，见 `absorbOpenSessions` 的写穿）。左栏分组与顶栏置顶胶囊都只认它 +
	 * 内存运行态叠加，所以「内存被 GC 卸掉」不会让任何行消失。
	 */
	allSessions: SessionMeta[];
	/** 手动添加过的项目目录（持久化 localStorage） */
	addedProjects: string[];
	selectedCwd: string | null;
	search: string;
	loading: boolean;
	loaded: boolean;
	load: () => Promise<void>;
	/** 重命名成功后同步历史列表（见实现处注释） */
	applySessionName: (sessionId: string, name: string | undefined) => void;
	select: (cwd: string | null) => void;
	setSearch: (search: string) => void;
	addProject: () => Promise<void>;
	/** 删除历史会话（含磁盘文件）；若该会话在顶栏打开中则一并关闭 */
	deleteSession: (session: SessionMeta) => Promise<void>;
	/** 删除整个项目：删除该项目下全部会话（含磁盘文件），并从已添加列表移除 */
	deleteProject: (cwd: string) => Promise<void>;
	/** 从历史会话打开并切回聊天视图；若已在顶栏打开则直接切换 */
	openSession: (session: SessionMeta) => Promise<void>;
}

/**
 * 列表刷新的单调序号（spec D6）：旧请求（含比新请求早发却晚回、或晚失败的那次）不得覆盖新请求的
 * `allSessions/loading/loaded`。模块级：不落盘、不进 store，重载归零也无意义。
 */
let loadSeq = 0;

export const useProjectsStore = create<ProjectsStore>((set, get) => ({
	allSessions: [],
	addedProjects: loadAddedProjects(),
	selectedCwd: null,
	search: "",
	loading: false,
	loaded: false,

	load: async () => {
		const seq = ++loadSeq;
		set({ loading: true });
		try {
			// 日常目录与全量会话并行取；目录进 lib/daily 模块缓存（isDailyCwd 同步判定供各组件用）
			const [allSessions] = await Promise.all([getPi().listAllSessions(), initDailyDir()]);
			// latest-wins：更晚的 load 已经发起 → 这份旧快照直接丢弃（loading 由最新那次收尾）
			if (seq !== loadSeq) return;
			set({ allSessions, loading: false, loaded: true });
			// 对账是**替换**语义（磁盘是存在性的权威），但内存里经手过的会话不能因此掉出目录：
			// 0 消息会话此时还没有会话文件（SDK 追加首条 entry 才落盘），磁盘快照里必然没有它 ——
			// 补回来才不会在随后被内存策略卸载时从 UI 消失
			absorbOpenSessions(useSessionsStore.getState().sessions);
			const { selectedCwd } = get();
			if (!selectedCwd) {
				const projects = deriveProjects(get());
				if (projects[0]) set({ selectedCwd: projects[0].cwd });
			}
		} catch {
			// 旧请求失败也不得插手：既不能覆盖新结果，也不能提前把新请求的 loading 置 false
			if (seq !== loadSeq) return;
			set({ loading: false, loaded: true });
		}
	},

	select: (cwd) => set({ selectedCwd: cwd, search: "" }),

	setSearch: (search) => set({ search }),

	addProject: async () => {
		const cwd = await getPi().pickDirectory();
		if (!cwd) return;
		// 信任前置：添加项目即决策（未决弹窗，结果落 trust.json），之后在新会话页/建会话都不再弹
		void getPi()
			.ensureProjectTrust({ cwd })
			.catch(() => {});
		const added = get().addedProjects;
		if (!added.includes(cwd)) {
			const next = [...added, cwd];
			localStorage.setItem(ADDED_KEY, JSON.stringify(next));
			set({ addedProjects: next });
		}
		set({ selectedCwd: cwd });
	},

	/** 重命名成功后同步历史列表：左栏会话行标题取自 `allSessions`，不同步就会「胶囊新名 / 左栏旧名」并存 */
	applySessionName: (sessionId, name) => {
		set((state) => ({
			allSessions: state.allSessions.map((s) => (s.sessionId === sessionId ? { ...s, name } : s)),
		}));
	},

	deleteSession: async (session) => {
		await getPi().deleteSession({ sessionId: session.sessionId, sessionFile: session.sessionFile });
		// 置顶列表清理：会话没了就没人能取消置顶，留着会变成永久残留 id
		useUiPreferencesStore.getState().unpin(session.sessionId);
		// D7：权限模式记录同理（与置顶并列；卸载/关会话**不**清，那是「记住」的意义）
		useUiPreferencesStore.getState().forgetPermissionMode(session.sessionId);
		const sessionsState = useSessionsStore.getState();
		if (sessionsState.sessions.some((s) => s.sessionId === session.sessionId)) {
			await sessionsState.closeSession(session.sessionId);
		}
		set((state) => ({
			allSessions: state.allSessions.filter((s) => s.sessionId !== session.sessionId),
		}));
	},

	deleteProject: async (cwd) => {
		// 内置日常空间不可删（侧栏本就不渲染删除钮，这里兜底防 IPC 重放等旁路）
		if (isDailyCwd(cwd)) return;
		const { allSessions } = get();
		for (const session of allSessions.filter((s) => s.cwd === cwd)) {
			await get().deleteSession(session);
		}
		const added = get().addedProjects.filter((p) => p !== cwd);
		localStorage.setItem(ADDED_KEY, JSON.stringify(added));
		set({ addedProjects: added });
		const { selectedCwd } = get();
		if (selectedCwd === cwd) {
			const projects = deriveProjects(get());
			set({ selectedCwd: projects[0]?.cwd ?? null, search: "" });
		}
	},

	openSession: async (session) => {
		const sessionsState = useSessionsStore.getState();
		if (sessionsState.sessions.some((s) => s.sessionId === session.sessionId)) {
			sessionsState.switchSession(session.sessionId);
			return;
		}
		await sessionsState.openFromHistory(session.sessionFile ?? "");
	},
}));

/**
 * 目录写穿：把内存里目录还没有的会话补进去（**只补缺、不覆盖**——磁盘权威的最小改动）。
 *
 * 为什么必须有这一层：磁盘历史只在「进新会话页 / 启动」时整表重拉，是**旧账**；而新建出来的会话
 * 必然比那次快照晚（快照是在它诞生之前拉的）。这段时间里它只活在内存 `sessions` 里，靠
 * `mergeSidebarSessions` 的合并撑着左栏行。内存策略（GC）一卸载它，内存里没了、旧账里也没有 →
 * 行凭空消失（2026-09-21 实测事故）。写穿把「存在性」提前落到目录，卸载就只是撤掉运行态。
 *
 * 不覆盖的理由：`createdAt/modifiedAt` 等稳定字段以磁盘为准（内存 meta 可能缺字段，盖上去会让
 * 排序键掉到 createdAt、行在打开/卸载时伪移动）；运行态字段本就在读取时由合并覆盖。
 */
function absorbOpenSessions(open: readonly SessionMeta[]): void {
	const state = useProjectsStore.getState();
	const known = new Set(state.allSessions.map((session) => session.sessionId));
	const missing = open.filter((session) => !known.has(session.sessionId));
	if (missing.length === 0) return;
	useProjectsStore.setState({ allSessions: [...state.allSessions, ...missing] });
}

// 写穿接线：**只此一处** —— 任何「会话进入内存」的路径（新建/打开/fork/从历史打开）都经它落目录，
// 将来新增路径也不会漏（不依赖各调用点自觉）。放在这里是因为依赖方向就是 projects → sessions。
useSessionsStore.subscribe((state, prev) => {
	if (state.sessions !== prev.sessions) absorbOpenSessions(state.sessions);
});

/** 项目列表 = 有历史会话的目录 ∪ 手动添加的目录（日常空间 cwd 除外，它在侧栏单独钉顶）；手动添加的按添加时间倒排（最新在前），未添加过的按最后活动排后 */
export function deriveProjects(state: Pick<ProjectsStore, "allSessions" | "addedProjects">): ProjectEntry[] {
	const byCwd = new Map<string, ProjectEntry>();
	for (const session of state.allSessions) {
		if (!session.cwd || isDailyCwd(session.cwd)) continue;
		const name = session.cwd.split("/").filter(Boolean).pop() ?? session.cwd;
		const modified = session.modifiedAt ?? session.createdAt;
		const existing = byCwd.get(session.cwd);
		if (existing) {
			existing.sessionCount += 1;
			existing.lastActive = Math.max(existing.lastActive, modified);
		} else {
			byCwd.set(session.cwd, {
				cwd: session.cwd,
				name,
				sessionCount: 1,
				lastActive: modified,
				addedIndex: -1,
			});
		}
	}
	for (const [idx, cwd] of state.addedProjects.entries()) {
		// 手动添加列表若混入日常目录（老版本/手改 localStorage）按未添加处理，不生成项目条目
		if (isDailyCwd(cwd)) continue;
		const existing = byCwd.get(cwd);
		if (existing) {
			existing.addedIndex = idx;
		} else {
			byCwd.set(cwd, {
				cwd,
				name: cwd.split("/").filter(Boolean).pop() ?? cwd,
				sessionCount: 0,
				lastActive: 0,
				addedIndex: idx,
			});
		}
	}
	return [...byCwd.values()].sort((a, b) => b.addedIndex - a.addedIndex || b.lastActive - a.lastActive);
}

/** 选中项目下按搜索过滤后的会话：置顶分区在左，其余按最后活动倒序。
 *  置顶列表来自 ui-preferences（local ∩ app 偏好），不进本 store 避免两份状态 */
export function deriveSessions(
	state: Pick<ProjectsStore, "allSessions" | "selectedCwd" | "search"> & {
		pinnedSessions: readonly string[];
	},
): SessionMeta[] {
	if (!state.selectedCwd) return [];
	const query = state.search.trim().toLowerCase();
	const filtered = state.allSessions
		.filter((s) => s.cwd === state.selectedCwd)
		.filter((s) => !query || (s.name ?? "").toLowerCase().includes(query) || s.sessionId.includes(query))
		.sort((a, b) => (b.modifiedAt ?? b.createdAt) - (a.modifiedAt ?? a.createdAt));
	return partitionSessionsByPin(filtered, state.pinnedSessions);
}
