import { environmentEntityRef, environmentKey, type SessionMeta } from "@percho/shared";
import { useEffect } from "react";
import { useT } from "../../i18n";
import type { SidebarGroup as Group } from "../../lib/sidebar-groups";
import { isPrimaryNavigationSession, mergeSidebarSessions } from "../../lib/sidebar-groups";
import { hasMoreSessions, visibleSessions } from "../../lib/sidebar-visible-count";
import { COMPOSER_FOCUS_EVENT } from "../../stores/drafts";
import { useProjectsStore } from "../../stores/projects";
import { useRemoteConnectionStore } from "../../stores/remote-connection";
import {
	EMPTY_CATALOG_ENVIRONMENT,
	sessionCatalogPageKey,
	useSessionCatalogStore,
} from "../../stores/session-catalog";
import { useSessionsStore } from "../../stores/sessions";
import { ProjectRow } from "./ProjectRow";
import { useSessionMenu } from "./SessionMenu";
import { SidebarSessionList } from "./SidebarSessionList";
import type { SidebarBatching } from "./useSidebarBatching";

/**
 * 分组的通用骨架（日常与每个项目共用一套，不写两套）：分组行 + 可折叠的会话列表 + 展开空态。
 * 会话行点击走 `openSession`（同一条路径同时覆盖「已打开 → 切换」与「未打开 → 从历史打开」）；
 * 右键菜单是 `useSessionMenu()`（菜单 / 改名气泡 / 删除确认三层都在那边）。
 * `pinned` / `onTogglePin` 只有项目组传（日常没有可置顶的语义，也就不给 «⋯»）。
 *
 * 显示层只画**当前该显示的那部分会话**：`batching` 给「这个组展开吗、点过几次显示更多」，
 * 本组件用纯 helper 裁出前 N 条（顺序仍由派生层定）。真实总数不受裁剪影响 —— 项目行的「移除」确认
 * 用的是 `totalSessions`，不是这里的行数。
 *
 * 展开态由 `batching` 解析后交给 `ProjectRow`：正常模式 = 持久化偏好，搜索模式 = 本轮临时值
 * （搜索期间点标题不能改偏好，见 `useSidebarBatching`）。
 */
export function SidebarGroup({
	group,
	activeSessionId,
	batching,
	pinned = false,
	totalSessions = 0,
	onTogglePin,
	onRemove,
	paging,
}: {
	group: Group;
	activeSessionId: string | null;
	/** 分批显示与搜索临时态（容器的内存态，本组件只问不改） */
	batching: SidebarBatching;
	pinned?: boolean;
	totalSessions?: number;
	onTogglePin?: (cwd: string) => void;
	onRemove?: () => void;
	paging?: {
		search: string;
		verified: SessionMeta[];
		pinnedSessions: readonly string[];
		known: readonly SessionMeta[];
	};
}) {
	const t = useT();
	const environment = environmentEntityRef(group.cwd).environment;
	const online = useRemoteConnectionStore(
		(state) =>
			environment.kind === "local" ||
			(state.status.state === "connected" &&
				!!state.status.environment &&
				environmentKey(state.status.environment) === environmentKey(environment)),
	);
	const openSession = useProjectsStore((s) => s.openSession);
	const activateNewSessionDraftForCwd = useSessionsStore((s) => s.activateNewSessionDraftForCwd);
	const sessionMenu = useSessionMenu();
	const expanded = batching.isExpanded(group.key, group.expanded);
	const moreClicks = batching.moreClicks(group.key);
	const search = paging?.search.trim() ?? "";
	const query = { cwd: group.cwd, ...(search ? { search } : {}), archived: false, limit: 6 };
	const pageKey = sessionCatalogPageKey(query);
	const catalog = useSessionCatalogStore(
		(s) => s.byEnvironment[environmentKey(environment)] ?? EMPTY_CATALOG_ENVIRONMENT,
	);
	const page = catalog.pages[pageKey];
	const memory = useSessionsStore((s) => s.sessions);
	const pagingEnabled = paging !== undefined;
	useEffect(() => {
		if (pagingEnabled && expanded && online)
			void useSessionCatalogStore.getState().loadPage(
				environmentEntityRef(group.cwd).environment,
				{
					cwd: group.cwd,
					...(search ? { search } : {}),
					archived: false,
					limit: 6,
				},
				false,
				true,
			);
	}, [pagingEnabled, expanded, online, group.cwd, search]);
	const pins = new Set(paging?.pinnedSessions ?? []);
	const extras = paging
		? [
				...paging.verified,
				...paging.known.filter((s) => !s.sessionFile && !s.archivedAt),
				...memory.filter((s) => !s.sessionFile && !s.archivedAt),
			]
		: [];
	const selected = paging
		? mergeSidebarSessions(
				[
					...(page?.sessions ?? []),
					...extras.filter(
						(s) =>
							s.cwd === group.cwd &&
							(!search ||
								(s.name ?? "").toLowerCase().includes(search.toLowerCase()) ||
								s.sessionId.toLowerCase().includes(search.toLowerCase())),
					),
				],
				memory.filter(
					(s) =>
						s.cwd === group.cwd &&
						((page?.sessions ?? []).some((item) => item.sessionId === s.sessionId) ||
							extras.some((item) => item.sessionId === s.sessionId)),
				),
			)
		: [];
	const pagedSessions = selected
		.filter((session) => !session.archivedAt && isPrimaryNavigationSession(session))
		.map((session) => ({ session, pinned: pins.has(session.sessionId) }))
		.sort(
			(a, b) =>
				Number(b.pinned) - Number(a.pinned) ||
				(b.session.modifiedAt ?? b.session.createdAt) - (a.session.modifiedAt ?? a.session.createdAt),
		)
		.slice(0, 6 + 16 * moreClicks);
	if (paging && search && page && !page.loading && !page.error && page.complete && pagedSessions.length === 0)
		return null;
	const openNewSession = () => {
		activateNewSessionDraftForCwd(group.cwd);
		requestAnimationFrame(() => window.dispatchEvent(new CustomEvent(COMPOSER_FOCUS_EVENT)));
	};
	return (
		<div data-sidebar-group-key={group.key}>
			<ProjectRow
				label={group.label ?? t("sidebar.daily")}
				cwd={group.cwd}
				environment={environment}
				kind={group.kind}
				expanded={expanded}
				pinned={pinned}
				totalSessions={totalSessions}
				onToggle={() => batching.toggleGroup(group.key, !expanded)}
				onNewSession={openNewSession}
				onTogglePin={onTogglePin ? () => onTogglePin(group.cwd) : undefined}
				onRemove={onRemove}
			/>
			<div
				data-sidebar-group-content={expanded ? "expanded" : "collapsed"}
				className={`sidebar-group-content ${expanded ? "is-expanded" : ""}`}
				aria-hidden={!expanded}
				inert={!expanded}
			>
				<div className="sidebar-group-content-inner">
					<SidebarSessionList
						sessions={paging ? pagedSessions : visibleSessions(group.sessions, moreClicks)}
						activeSessionId={activeSessionId}
						emptyLabel={t("sidebar.noSessions")}
						showMoreLabel={t("sidebar.showMore")}
						hasMore={
							paging
								? !!page?.nextCursor || selected.length > pagedSessions.length
								: hasMoreSessions(group.sessions.length, moreClicks)
						}
						onShowMore={() => {
							batching.showMore(group.key);
							if (paging && page?.nextCursor)
								void useSessionCatalogStore.getState().loadPage(environment, query, true);
						}}
						paging={
							paging
								? {
										offline: !online,
										onConnect: () => useRemoteConnectionStore.getState().setOpen(true),
										loading: online && (!page || page.loading),
										error: page?.error,
										partial: !!page && !page.complete,
										onRetry: () => void useSessionCatalogStore.getState().loadPage(environment, query),
									}
								: undefined
						}
						onSelect={(session) => void openSession(session)}
						onContextMenu={(session, anchor) => sessionMenu.open(session, anchor)}
					/>
				</div>
			</div>
			{sessionMenu.element}
		</div>
	);
}
