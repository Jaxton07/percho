import { useT } from "../../i18n";
import type { SidebarGroup as Group } from "../../lib/sidebar-groups";
import { useProjectsStore } from "../../stores/projects";
import { ProjectRow } from "./ProjectRow";
import { useSessionMenu } from "./SessionMenu";
import { SessionRow } from "./SessionRow";

/**
 * 分组的通用骨架（日常与每个项目共用一套，不写两套）：分组行 + 可折叠的会话列表 + 展开空态。
 * 会话行点击走 `openSession`（同一条路径同时覆盖「已打开 → 切换」与「未打开 → 从历史打开」）；
 * 右键菜单是 `useSessionMenu()`（菜单 / 改名气泡 / 删除确认三层都在那边）。
 * `pinned` / `onTogglePin` 只有项目组传（日常没有可置顶的语义，也就不给 «⋯»）。
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
	const sessionMenu = useSessionMenu();
	return (
		<div>
			<ProjectRow
				label={group.label ?? t("sidebar.daily")}
				kind={group.kind}
				expanded={group.expanded}
				pinned={pinned}
				totalSessions={totalSessions}
				onToggle={() => onToggle(group.key)}
				onTogglePin={onTogglePin ? () => onTogglePin(group.cwd) : undefined}
				onRemove={onRemove}
			/>
			{group.expanded &&
				(group.sessions.length > 0 ? (
					group.sessions.map(({ session }) => (
						<SessionRow
							key={session.sessionId}
							session={session}
							active={session.sessionId === activeSessionId}
							onSelect={() => void openSession(session)}
							onContextMenu={(anchor) => sessionMenu.open(session, anchor)}
						/>
					))
				) : (
					<p className="py-1 pl-[30px] text-[12px] text-ink-faint">{t("sidebar.noSessions")}</p>
				))}
			{sessionMenu.element}
		</div>
	);
}
