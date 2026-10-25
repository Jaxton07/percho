import { environmentEntityRef } from "@percho/shared";
import { useT } from "../../i18n";
import type { SidebarGroup as Group } from "../../lib/sidebar-groups";
import { hasMoreSessions, visibleSessions } from "../../lib/sidebar-visible-count";
import { COMPOSER_FOCUS_EVENT } from "../../stores/drafts";
import { useProjectsStore } from "../../stores/projects";
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
}: {
	group: Group;
	activeSessionId: string | null;
	/** 分批显示与搜索临时态（容器的内存态，本组件只问不改） */
	batching: SidebarBatching;
	pinned?: boolean;
	totalSessions?: number;
	onTogglePin?: (cwd: string) => void;
	onRemove?: () => void;
}) {
	const t = useT();
	const environment = environmentEntityRef(group.cwd).environment;
	const openSession = useProjectsStore((s) => s.openSession);
	const activateNewSessionDraftForCwd = useSessionsStore((s) => s.activateNewSessionDraftForCwd);
	const sessionMenu = useSessionMenu();
	const expanded = batching.isExpanded(group.key, group.expanded);
	const moreClicks = batching.moreClicks(group.key);
	const openNewSession = () => {
		activateNewSessionDraftForCwd(group.cwd);
		requestAnimationFrame(() => window.dispatchEvent(new CustomEvent(COMPOSER_FOCUS_EVENT)));
	};
	return (
		<div data-sidebar-group-key={group.key}>
			<ProjectRow
				label={group.label ?? t("sidebar.daily")}
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
						sessions={visibleSessions(group.sessions, moreClicks)}
						activeSessionId={activeSessionId}
						emptyLabel={t("sidebar.noSessions")}
						showMoreLabel={t("sidebar.showMore")}
						hasMore={hasMoreSessions(group.sessions.length, moreClicks)}
						onShowMore={() => batching.showMore(group.key)}
						onSelect={(session) => void openSession(session)}
						onContextMenu={(session, anchor) => sessionMenu.open(session, anchor)}
					/>
				</div>
			</div>
			{sessionMenu.element}
		</div>
	);
}
