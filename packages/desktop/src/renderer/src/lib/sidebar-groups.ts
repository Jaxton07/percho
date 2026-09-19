import type { SessionMeta } from "@percho/shared";
import type { ProjectEntry } from "../stores/projects";
import { partitionSessionsByPin } from "../stores/sessions";
import { getDailyDirCached } from "./daily";

/**
 * 左侧栏的纯派生层：把「全量历史会话 + 项目表 + 偏好」算成可直接渲染的分组数组。
 * 纪律：不 import React、不读写持久化、不调 IPC —— 组件只做展示，展开/置顶状态一律由调用方传入。
 * 两个共用纯助手也放这里：`toggleInList`（置顶切换，会话与项目共用）、`toggleExpandedGroup`（展开切换）。
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

export type SidebarGroupsInput = {
	/** 全量历史会话（含未打开的） */
	sessions: readonly SessionMeta[];
	/** 项目表：**复用 `deriveProjects(projectsStore)` 的输出**（已排除日常目录、已含「只有会话」与「手动添加」两类） */
	projects: readonly ProjectEntry[];
	/** 搜索词（与 `deriveSessions` 同规则：命中名称或 sessionId，空串不过滤） */
	search: string;
	activeSessionId: string | null;
	pinnedSessions: readonly string[];
	pinnedProjects: readonly string[];
	expandedGroups: readonly string[];
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
 * 展开推断：`expandedGroups` 为空（用户没手动开合过）→ 只展开当前会话所在组；
 * 非空 → 完全以记录为准（用户把当前组折叠了也尊重）。
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
	const activeCwd = input.activeSessionId
		? (input.sessions.find((session) => session.sessionId === input.activeSessionId)?.cwd ?? null)
		: null;
	const defaultExpandedKeys = activeCwd ? [activeCwd] : [];
	const expandedKeys = input.expandedGroups.length > 0 ? input.expandedGroups : defaultExpandedKeys;
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

/** 置顶 / 取消置顶（新置顶排最前）：会话与项目共用，store 与组件都走它，别各写一套 */
export function toggleInList(list: readonly string[], id: string): string[] {
	return list.includes(id) ? list.filter((item) => item !== id) : [id, ...list];
}

/**
 * 展开 / 折叠一个分组（纯逻辑）：`current` 为空 = 用户还没手动开合过，
 * 以 `defaults`（派生层给的默认展开集）为起点再翻转 —— 否则首次点开某个组会把当前组一起折掉。
 */
export function toggleExpandedGroup(
	current: readonly string[],
	key: string,
	defaults: readonly string[],
): string[] {
	const base = current.length > 0 ? [...current] : [...defaults];
	return base.includes(key) ? base.filter((item) => item !== key) : [...base, key];
}
