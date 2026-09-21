import { useT } from "../../i18n";
import type { SidebarGroup as Group } from "../../lib/sidebar-groups";
import { COMPOSER_FOCUS_EVENT } from "../../stores/drafts";
import { useProjectsStore } from "../../stores/projects";
import { useSessionsStore } from "../../stores/sessions";
import { ProjectRow } from "./ProjectRow";
import { useSessionMenu } from "./SessionMenu";
import { SidebarSessionList } from "./SidebarSessionList";

/**
 * 分组的通用骨架（日常与每个项目共用一套，不写两套）：分组行 + 可折叠的会话列表 + 展开空态。
 * 会话行点击走 `openSession`（同一条路径同时覆盖「已打开 → 切换」与「未打开 → 从历史打开」）；
 * 右键菜单是 `useSessionMenu()`（菜单 / 改名气泡 / 删除确认三层都在那边）。
 * `pinned` / `onTogglePin` 只有项目组传（日常没有可置顶的语义，也就不给 «⋯»）。
 * **列表本身（限高 + 组内滚动）在 `SidebarSessionList` 里**：标题行由本组件渲染在它之外，
 * 于是内层滚动容器只圈住会话行，标题上的滚轮自然滚外层项目导航（spec §4.2）。
 */
export function SidebarGroup({
	group,
	activeSessionId,
	pinned = false,
	totalSessions = 0,
	onToggle,
	onTogglePin,
	onRemove,
}: {
	group: Group;
	activeSessionId: string | null;
	pinned?: boolean;
	totalSessions?: number;
	onToggle: (key: string) => void;
	onTogglePin?: (cwd: string) => void;
	onRemove?: () => void;
}) {
	const t = useT();
	const openSession = useProjectsStore((s) => s.openSession);
	const activateNewSessionDraftForCwd = useSessionsStore((s) => s.activateNewSessionDraftForCwd);
	const sessionMenu = useSessionMenu();
	const openNewSession = () => {
		activateNewSessionDraftForCwd(group.cwd);
		requestAnimationFrame(() => window.dispatchEvent(new CustomEvent(COMPOSER_FOCUS_EVENT)));
	};
	return (
		<div>
			<ProjectRow
				label={group.label ?? t("sidebar.daily")}
				kind={group.kind}
				expanded={group.expanded}
				pinned={pinned}
				totalSessions={totalSessions}
				onToggle={() => onToggle(group.key)}
				onNewSession={openNewSession}
				onTogglePin={onTogglePin ? () => onTogglePin(group.cwd) : undefined}
				onRemove={onRemove}
			/>
			{group.expanded && (
				<SidebarSessionList
					sessions={group.sessions}
					activeSessionId={activeSessionId}
					emptyLabel={t("sidebar.noSessions")}
					onSelect={(session) => void openSession(session)}
					onContextMenu={(session, anchor) => sessionMenu.open(session, anchor)}
				/>
			)}
			{sessionMenu.element}
		</div>
	);
}
