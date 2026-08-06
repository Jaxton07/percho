import { useT } from "../i18n";
import { useSessionsStore } from "../stores/sessions";
import { useTranscriptStore } from "../stores/transcript";
import { useUiStore } from "../stores/ui";
import { ComposeIcon } from "./ProjectPage";

/** 顶栏：macOS hiddenInset 红绿灯左侧，会话 tab 从右排开 */
export function SessionTabBar() {
	const t = useT();
	const sessions = useSessionsStore((s) => s.sessions);
	const activeSessionId = useSessionsStore((s) => s.activeSessionId);
	const switchSession = useSessionsStore((s) => s.switchSession);
	const closeSession = useSessionsStore((s) => s.closeSession);
	const createSession = useSessionsStore((s) => s.createSession);
	const cwd = useSessionsStore((s) => s.cwd);
	const view = useUiStore((s) => s.view);
	const setView = useUiStore((s) => s.setView);
	const phase = useTranscriptStore((s) =>
		activeSessionId ? s.bySession[activeSessionId]?.phase : undefined,
	);

	return (
		<div className="drag-region flex h-12 shrink-0 items-center gap-1 border-b border-zinc-200 bg-[var(--color-bg)] pl-20 pr-3">
			<button
				type="button"
				className={`no-drag shrink-0 rounded-lg p-1.5 transition-colors ${
					view === "projects"
						? "bg-zinc-200/80 text-zinc-900"
						: "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800"
				}`}
				onClick={() => setView(view === "projects" ? "chat" : "projects")}
				title={t("projects.title")}
				aria-label={t("projects.title")}
			>
				<svg
					width="15"
					height="15"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					aria-hidden="true"
				>
					<rect x="3" y="3" width="7" height="7" rx="1.5" />
					<rect x="14" y="3" width="7" height="7" rx="1.5" />
					<rect x="3" y="14" width="7" height="7" rx="1.5" />
					<rect x="14" y="14" width="7" height="7" rx="1.5" />
				</svg>
			</button>
			<div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
				{sessions.map((session) => {
					const isActive = session.sessionId === activeSessionId;
					const isStreaming = isActive && phase === "streaming";
					const letter = session.name?.[0] ?? session.cwd.split("/").filter(Boolean).pop()?.[0] ?? "P";
					return (
						<button
							type="button"
							key={session.sessionId}
							className={`no-drag group relative flex shrink-0 cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm transition-colors ${
								isActive
									? "bg-zinc-200/80 text-zinc-900"
									: "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800"
							}`}
							onClick={() => {
								switchSession(session.sessionId);
								setView("chat");
							}}
						>
							<span
								className={`flex h-4 w-4 items-center justify-center rounded text-[10px] font-semibold text-white ${
									isActive ? "bg-violet-500" : "bg-zinc-400"
								}`}
							>
								{letter.toUpperCase()}
							</span>
							<span className="max-w-40 truncate">
								{session.name ?? session.cwd.split("/").filter(Boolean).pop() ?? t("tabbar.untitled")}
							</span>
							{isStreaming && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-violet-500" />}
							<span
								className="absolute -right-1.5 -top-1.5 rounded p-0.5 text-zinc-400 opacity-0 transition-opacity hover:bg-zinc-300/60 hover:text-zinc-700 group-hover:opacity-100"
								aria-hidden="true"
								onClick={(e) => {
									e.stopPropagation();
									void closeSession(session.sessionId);
								}}
							>
								<svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
									<path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
								</svg>
							</span>
						</button>
					);
				})}
				{sessions.length === 0 && <span className="px-2 text-sm text-zinc-400">{t("tabbar.noProject")}</span>}
			</div>
			<button
				type="button"
				className="no-drag shrink-0 rounded-lg p-1.5 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800"
				onClick={() => {
					void createSession();
					setView("chat");
				}}
				title={cwd ? t("tabbar.newSession") : t("tabbar.pickProjectFirst")}
				aria-label={t("tabbar.newSession")}
			>
				<ComposeIcon size={15} />
			</button>
		</div>
	);
}
