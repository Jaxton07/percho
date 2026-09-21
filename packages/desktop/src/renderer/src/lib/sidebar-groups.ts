import type { SessionMeta } from "@percho/shared";
import { deriveProjects, type ProjectEntry } from "../stores/projects";
import { partitionSessionsByPin } from "../stores/sessions";
import { getDailyDirCached } from "./daily";
import { isPrimaryNavigationSession } from "./session-visibility";

export { isPrimaryNavigationSession };

/**
 * 左侧栏的纯派生层：把「会话目录 + 项目表 + 偏好」算成可直接渲染的分组数组。
 * 纪律：不 import React、不读写持久化、不调 IPC —— 组件只做展示，展开/置顶状态一律由调用方传入。
 *
 * v7：「项目」小标不再可折叠（只是固定标题分割区）——`PROJECTS_GROUP_KEY` / `projectsExpanded` 已删；
 * `expandedGroups` 里可能残留的历史值 `__projects__` 不会匹配任何 cwd，自然失效，无需数据迁移。
 */

export type SidebarSession = {
	session: SessionMeta;
	pinned: boolean;
};

/** 一个可折叠分组（日常空间与每个项目同构，渲染侧共用一套行组件） */
export type SidebarGroup = {
	/** 组 key = cwd（expandedGroups 里存的就是它） */
	key: string;
	kind: "daily" | "project";
	cwd: string;
	/** 项目组为目录名；**日常组为 null** —— 渲染侧取 i18n 的「日常」文案，纯函数层不产出用户可见中文 */
	label: string | null;
	sessionCount: number;
	/** 已排序：置顶在前，其余按最后活动倒序 */
	sessions: SidebarSession[];
	expanded: boolean;
};

export type SidebarProjectEntry = SidebarGroup & {
	pinned: boolean;
	/** 该项目下的会话总数（**不受搜索过滤**）：移除项目的确认文案要写真实数字，不能写当前筛选后的 */
	totalSessions: number;
};

export type SidebarGroupsResult = {
	daily: SidebarGroup | null;
	projects: SidebarProjectEntry[];
	/** 无用户记录时的默认展开集（= 默认推断结果），供 useExpandedGroups 在用户首次开合时当起点 */
	defaultExpandedKeys: string[];
};

/**
 * 同 ID 合并（spec D1）：运行态字段（name/model/active/messageCount/readOnly…）以**内存**为准，
 * 但**稳定时间字段**不能被不完整的活跃 meta 抹掉：
 *
 * - `createdAt`：历史（磁盘 header 时间）是权威值。活跃 meta 曾经用文件 birthtime，复制/恢复会话文件就会变；
 * - `modifiedAt`：内存 meta 缺活动时间（老 registry meta）时**保留历史值**。丢了它排序键会从
 *   `modifiedAt` 掉到 `createdAt`（`groupSessions` 的 `modifiedAt ?? createdAt`），
 *   于是「点一下历史行，它就跳到别处」——同一个会话并未真的产生新活动。
 */
function mergeSessionMeta(history: SessionMeta, memory: SessionMeta): SessionMeta {
	return {
		...memory,
		createdAt: history.createdAt,
		modifiedAt: memory.modifiedAt ?? history.modifiedAt,
	};
}

/**
 * 左栏数据源合并：**会话目录（`projects.allSessions`）+ 当前内存会话（`sessions.sessions`）**。
 * 内存项按 `sessionId` 覆盖目录项（名称/模型/状态以当前实例为准，时间字段走 `mergeSessionMeta` 合并），
 * 目录项保持原顺序，内存独有项按内存顺序补在后面。**不负责排序**：组内排序统一由 `groupSessions` 做
 * （最后活动倒序 + 置顶分区）。
 *
 * ⚠️ **「行存不存在」的判断依据是目录，不是内存**：会话一进内存就被写穿进目录
 * （`stores/projects.ts` 的 `absorbOpenSessions`），所以 GC 卸载内存不会让行消失。下面的
 * 「内存独有项补在后面」只是兜时序的防御（模块加载早期订阅还没装、测试里直接 setState），
 * **别再把它当存在性的依靠** —— 2026-09-21 的事故正是「新建的会话只活在内存里 + 被 GC 卸载」
 * = 行凭空消失。新会话页没有会话条目，靠 `activeCwd` 展开当前组。
 */
export function mergeSidebarSessions(
	history: readonly SessionMeta[],
	memory: readonly SessionMeta[],
): SessionMeta[] {
	// Map 保序：覆盖同 id 不会改变它原有的插入位置（历史顺序不被改写）
	const byId = new Map<string, SessionMeta>();
	for (const session of history) byId.set(session.sessionId, session);
	for (const session of memory) {
		const previous = byId.get(session.sessionId);
		byId.set(session.sessionId, previous ? mergeSessionMeta(previous, session) : session);
	}
	return [...byId.values()];
}

export type SidebarGroupsInput = {
	/** 会话目录（`projects.allSessions`：磁盘历史 ∪ 本进程经手过的会话）；**调用方应先过 `isPrimaryNavigationSession`**（见 `deriveSidebarNavigation`） */
	sessions: readonly SessionMeta[];
	/** 项目表：**复用 `deriveProjects(projectsStore)` 的输出**（已排除日常目录、已含「只有会话」与「手动添加」两类） */
	projects: readonly ProjectEntry[];
	/** 搜索词（与 `deriveSessions` 同规则：命中名称或 sessionId，空串不过滤） */
	search: string;
	/**
	 * 当前会话所在目录（新会话页 = draft 的目录），只用来算默认展开组。
	 * **显式传入、不从 `sessions` 反查**：只读子会话会被导航投影过滤掉，反查会丢信息；
	 * 传 `null` 就是「没有当前目录」（如新会话页还没选项目），不得回退去反查。
	 */
	activeCwd: string | null;
	pinnedSessions: readonly string[];
	pinnedProjects: readonly string[];
	/** 已展开的分组 key（**含义由 `expandedGroupsTouched` 决定**） */
	expandedGroups: readonly string[];
	/** false = 用户还没手动开合过（走默认推断，`expandedGroups` 不参与）；true = 完全以 `expandedGroups` 为准（空数组 = 全部折叠） */
	expandedGroupsTouched: boolean;
};

/** `deriveSidebarNavigation` 的输入：左栏需要的两个数据源（历史 + 内存）+ 项目表 + 偏好 */
export type SidebarNavigationInput = {
	/** 会话目录（`projects.allSessions`）：行存在性的唯一来源 */
	history: readonly SessionMeta[];
	/** 当前内存会话（`sessions.sessions`）：只负责叠运行态与补还没落盘的新会话 */
	memory: readonly SessionMeta[];
	/** 手动添加过的项目目录（`projects.addedProjects`） */
	addedProjects: string[];
	search: string;
	activeCwd: string | null;
	pinnedSessions: readonly string[];
	pinnedProjects: readonly string[];
	expandedGroups: readonly string[];
	expandedGroupsTouched: boolean;
};

function matchesSearch(session: SessionMeta, query: string): boolean {
	if (!query) return true;
	return (session.name ?? "").toLowerCase().includes(query) || session.sessionId.includes(query);
}

/** 组内会话：按最后活动倒序（置顶分区前置由 partitionSessionsByPin 负责，它要求输入已排序） */
function groupSessions(list: readonly SessionMeta[], pinned: ReadonlySet<string>): SidebarSession[] {
	const sorted = [...list].sort((a, b) => (b.modifiedAt ?? b.createdAt) - (a.modifiedAt ?? a.createdAt));
	return partitionSessionsByPin(sorted, [...pinned]).map((session) => ({
		session,
		pinned: pinned.has(session.sessionId),
	}));
}

/**
 * 左侧栏分组派生。
 *
 * 排序：项目区 = 置顶项目在前（按 `pinnedProjects` 顺序），**其余保持 `deriveProjects` 的既有顺序**
 * （手动添加的按添加时间倒排 → 刚添加的项目仍排最上面，不会因 0 会话沉底；spec §5.2 写的是
 * 「其余按 lastActive 倒序」，与同段「直接用 deriveProjects 的输出」互斥，取后者）。
 * 组内 = 置顶会话在前，其余按最后活动倒序。
 *
 * 展开推断：`expandedGroupsTouched === false`（用户从没手动开合过）→ 只展开当前会话所在组；
 * `true` → 完全以 `expandedGroups` 为准（把当前组折了也尊重，**空数组 = 全部折叠**）。
 * 旧版拿「空数组」兼任两种含义，导致最后一个展开组折不掉（见 spec D4）。
 *
 * 搜索：命中为空的分组整体隐藏（含日常组），避免满屏空组。
 */
export function deriveSidebarGroups(input: SidebarGroupsInput): SidebarGroupsResult {
	const query = input.search.trim().toLowerCase();
	const visible = input.sessions.filter((session) => matchesSearch(session, query));
	const searching = query.length > 0;

	const byCwd = new Map<string, SessionMeta[]>();
	for (const session of visible) {
		const list = byCwd.get(session.cwd);
		if (list) list.push(session);
		else byCwd.set(session.cwd, [session]);
	}

	const pinnedSessions = new Set(input.pinnedSessions);
	// 默认展开组只能来自显式 activeCwd：从 sessions 里反查 active 会因只读子会话被过滤而丢信息
	const defaultExpandedKeys = input.activeCwd ? [input.activeCwd] : [];
	// 展开态的唯一判据是 touched 位，不是「数组空不空」：空数组合法表示「用户把最后一组也折了」
	const expandedKeys = input.expandedGroupsTouched ? input.expandedGroups : defaultExpandedKeys;
	const isExpanded = (key: string) => expandedKeys.includes(key);

	const dailyCwd = getDailyDirCached();
	const dailySessions = dailyCwd ? (byCwd.get(dailyCwd) ?? []) : [];
	const daily =
		dailyCwd && (!searching || dailySessions.length > 0)
			? {
					key: dailyCwd,
					kind: "daily" as const,
					cwd: dailyCwd,
					label: null,
					sessionCount: dailySessions.length,
					sessions: groupSessions(dailySessions, pinnedSessions),
					expanded: isExpanded(dailyCwd),
				}
			: null;

	const matched = input.projects.filter((project) => !searching || (byCwd.get(project.cwd)?.length ?? 0) > 0);
	const byCwdProject = new Map(matched.map((project) => [project.cwd, project]));
	const pinnedProjects = input.pinnedProjects
		.map((cwd) => byCwdProject.get(cwd))
		.filter((project): project is ProjectEntry => project !== undefined);
	const pinnedSet = new Set(pinnedProjects.map((project) => project.cwd));
	const ordered = [...pinnedProjects, ...matched.filter((project) => !pinnedSet.has(project.cwd))];

	return {
		daily,
		projects: ordered.map((project) => {
			const sessions = byCwd.get(project.cwd) ?? [];
			return {
				key: project.cwd,
				kind: "project" as const,
				cwd: project.cwd,
				label: project.name,
				sessionCount: sessions.length,
				sessions: groupSessions(sessions, pinnedSessions),
				expanded: isExpanded(project.cwd),
				pinned: pinnedSet.has(project.cwd),
				totalSessions: project.sessionCount,
			};
		}),
		defaultExpandedKeys,
	};
}

/**
 * 历史 + 内存合并后，只留进导航的主会话（只读子会话检视态不进左栏，spec §6）。
 * **过滤只发生在投影层**：store 里那份会话仍然活着（事件/transcript/关闭都靠它）。
 */
export function primaryNavigationSessions(
	history: readonly SessionMeta[],
	memory: readonly SessionMeta[],
): SessionMeta[] {
	return mergeSidebarSessions(history, memory).filter(isPrimaryNavigationSession);
}

/**
 * 左栏装配（Sidebar 与单测**共用同一条路径**，不在测试里手抄装配顺序）：
 * 历史 + 内存合并 → 统一过滤只读子会话 → **同一份集合**同时喂给项目表与分组派生。
 * 项目表必须也用过滤后的集合：否则只读子会话所在目录会凭空长出一个（计数虚高的）项目组。
 */
export function deriveSidebarNavigation(input: SidebarNavigationInput): SidebarGroupsResult {
	const sessions = primaryNavigationSessions(input.history, input.memory);
	return deriveSidebarGroups({
		sessions,
		projects: deriveProjects({ allSessions: sessions, addedProjects: input.addedProjects }),
		search: input.search,
		activeCwd: input.activeCwd,
		pinnedSessions: input.pinnedSessions,
		pinnedProjects: input.pinnedProjects,
		expandedGroups: input.expandedGroups,
		expandedGroupsTouched: input.expandedGroupsTouched,
	});
}

/**
 * 展开 / 折叠一个分组（纯逻辑）：以 `touched` 判据——用户还没操作过就用 `defaults`
 * （派生层给的默认展开集）当起点再翻转，否则在用户的现有记录上翻转。
 * 后者是关键：touched=true 且记录为空（全部折叠）时，点一个组应当**只展开它**，
 * 不能再回退默认集（否则会把当前会话所在组一起拉出来）。
 * `touched` 缺省按 `current.length > 0` 推断，兼容旧调用（旧版非空记录即「已操作」）。
 */
export function toggleExpandedGroup(
	current: readonly string[],
	key: string,
	defaults: readonly string[],
	touched: boolean = current.length > 0,
): string[] {
	const base = touched ? [...current] : [...defaults];
	return base.includes(key) ? base.filter((item) => item !== key) : [...base, key];
}
