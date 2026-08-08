import type { SessionMeta } from "@pi-desktop/shared";
import { useState } from "react";
import { useT } from "../../i18n";
import { useProjectsStore } from "../../stores/projects";
import { useUiStore } from "../../stores/ui";
import { CloseIcon } from "../icons";

/** 历史会话行：点击打开，hover 出现删除（二次确认） */
export function SessionRow({ session }: { session: SessionMeta }) {
	const t = useT();
	const openSession = useProjectsStore((s) => s.openSession);
	const deleteSession = useProjectsStore((s) => s.deleteSession);
	const setView = useUiStore((s) => s.setView);
	const [confirming, setConfirming] = useState(false);

	return (
		<li className="group relative" onMouseLeave={() => setConfirming(false)}>
			<button
				type="button"
				className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-hover"
				onClick={() => {
					if (session.sessionFile) {
						void openSession(session).then(() => setView("chat"));
					}
				}}
			>
				<span className="min-w-0 flex-1 truncate text-[13px] text-ink">
					{session.name ?? t("projects.untitled")}
				</span>
				<span className="shrink-0 text-[11px] text-ink-faint group-hover:invisible">
					{t("projects.messages", { count: session.messageCount })}
				</span>
			</button>
			<button
				type="button"
				className={`invisible absolute right-2 top-1/2 -translate-y-1/2 rounded-md px-1.5 py-0.5 text-[11px] transition-colors group-hover:visible ${
					confirming ? "bg-red-50 text-red-600" : "text-ink-faint hover:bg-hover hover:text-ink-2"
				}`}
				onClick={() => {
					if (confirming) {
						void deleteSession(session);
					} else {
						setConfirming(true);
					}
				}}
				title={t("projects.delete")}
			>
				{confirming ? t("projects.confirmDelete") : <CloseIcon />}
			</button>
		</li>
	);
}
