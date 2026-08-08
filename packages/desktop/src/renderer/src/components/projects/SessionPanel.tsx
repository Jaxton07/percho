import { useMemo } from "react";
import { useT } from "../../i18n";
import { deriveSessions, useProjectsStore } from "../../stores/projects";
import { useSessionsStore } from "../../stores/sessions";
import { useUiStore } from "../../stores/ui";
import { ComposeIcon } from "../icons";
import { groupByDate } from "./date-groups";
import { SessionRow } from "./SessionRow";

const GROUP_LABELS = {
	today: "projects.today",
	yesterday: "projects.yesterday",
	earlier: "projects.earlier",
} as const;

/** 右侧会话面板：新会话按钮 + 按日期分组的会话列表 */
export function SessionPanel() {
	const t = useT();
	const selectedCwd = useProjectsStore((s) => s.selectedCwd);
	const search = useProjectsStore((s) => s.search);
	const allSessions = useProjectsStore((s) => s.allSessions);
	const sessions = useMemo(
		() => deriveSessions({ allSessions, selectedCwd, search }),
		[allSessions, selectedCwd, search],
	);
	const createSession = useSessionsStore((s) => s.createSession);
	const setView = useUiStore((s) => s.setView);

	const groups = groupByDate(sessions);

	const newSession = async () => {
		if (!selectedCwd) return;
		await createSession(selectedCwd);
		setView("chat");
	};

	return (
		<div className="flex min-w-0 flex-1 flex-col">
			<div className="flex shrink-0 items-center justify-end px-5 pt-3">
				<button
					type="button"
					className="flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] text-ink-2 transition-colors hover:bg-hover disabled:opacity-40"
					onClick={() => void newSession()}
					disabled={!selectedCwd}
				>
					<ComposeIcon />
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
