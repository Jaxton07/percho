import { useMemo } from "react";
import { useT } from "../../i18n";
import { deriveSessions, useProjectsStore } from "../../stores/projects";
import { useSessionsStore } from "../../stores/sessions";
import { useUiStore } from "../../stores/ui";
import { useUiPreferencesStore } from "../../stores/ui-preferences";
import { PlusIcon } from "../icons";
import { groupSessions } from "./date-groups";
import { SessionRow } from "./SessionRow";

const GROUP_LABELS = {
	pinned: "projects.pinned",
	today: "projects.today",
	yesterday: "projects.yesterday",
	earlier: "projects.earlier",
} as const;

/** 右侧会话面板：新会话按钮 + 置顶/按日期分组的会话列表 */
export function SessionPanel() {
	const t = useT();
	const selectedCwd = useProjectsStore((s) => s.selectedCwd);
	const search = useProjectsStore((s) => s.search);
	const allSessions = useProjectsStore((s) => s.allSessions);
	const pinnedSessions = useUiPreferencesStore((s) => s.pinnedSessions);
	const sessions = useMemo(
		() => deriveSessions({ allSessions, selectedCwd, search, pinnedSessions }),
		[allSessions, selectedCwd, search, pinnedSessions],
	);
	const createDraftSession = useSessionsStore((s) => s.createDraftSession);
	const setView = useUiStore((s) => s.setView);

	const groups = useMemo(() => groupSessions(sessions, pinnedSessions), [sessions, pinnedSessions]);

	const newSession = () => {
		if (!selectedCwd) return;
		// draft tab：发送首条消息时才真正创建，期间仍可在空态切换项目
		createDraftSession(selectedCwd);
		setView("chat");
	};

	return (
		<div className="flex min-w-0 flex-1 flex-col">
			<div className="flex shrink-0 items-center justify-end px-5 pt-3">
				<button
					type="button"
					className="flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] text-ink-2 transition-colors hover:bg-hover disabled:opacity-40"
					onClick={newSession}
					disabled={!selectedCwd}
				>
					<PlusIcon />
					{t("projects.newSession")}
				</button>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">
				{sessions.length === 0 && (
					<p className="py-10 text-center text-[13px] text-ink-faint">{t("projects.noSessions")}</p>
				)}
				{groups.map((group) => (
					<div key={group.key}>
						<h3 className="pt-4 pb-2 text-[13px] font-medium text-ink-dim">{t(GROUP_LABELS[group.key])}</h3>
						<ul className="flex flex-col gap-0.5">
							{group.sessions.map((session) => (
								<SessionRow key={session.sessionId} session={session} />
							))}
						</ul>
					</div>
				))}
			</div>
		</div>
	);
}
