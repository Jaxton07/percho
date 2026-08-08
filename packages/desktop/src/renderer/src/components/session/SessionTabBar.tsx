import { useEffect, useRef } from "react";
import { useT } from "../../i18n";
import { useSessionsStore } from "../../stores/sessions";
import { useTranscriptStore } from "../../stores/transcript";
import { useUiStore } from "../../stores/ui";
import { CloseIcon, ComposeIcon, GridIcon } from "../icons";

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
	const scrollerRef = useRef<HTMLDivElement>(null);

	// 鼠标滚轮（垂直）→ tab 横向滚动
	useEffect(() => {
		const el = scrollerRef.current;
		if (!el) return;
		const onWheel = (e: WheelEvent) => {
			const scrollable = el.scrollWidth > el.clientWidth;
			if (!scrollable) return;
			const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
			if (dx === 0) return;
			e.preventDefault();
			el.scrollLeft += dx;
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		return () => el.removeEventListener("wheel", onWheel);
	}, []);

	return (
		<div className="drag-region flex h-12 shrink-0 items-center gap-1 border-b border-border bg-canvas pl-20 pr-3">
			<button
				type="button"
				className={`no-drag shrink-0 rounded-lg p-1.5 transition-colors ${
					view === "projects" ? "bg-border/80 text-ink" : "text-ink-dim hover:bg-hover hover:text-ink"
				}`}
				onClick={() => setView(view === "projects" ? "chat" : "projects")}
				title={t("projects.title")}
				aria-label={t("projects.title")}
			>
				<GridIcon />
			</button>
			<div
				ref={scrollerRef}
				className="flex min-w-0 flex-1 items-center gap-1 overflow-x-scroll [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
			>
				{sessions.map((session) => {
					const isActive = session.sessionId === activeSessionId;
					const isStreaming = isActive && phase === "streaming";
					// 图标字母 = 项目名（cwd 最后一段）首字母，与会话标题无关
					const letter = session.cwd.split("/").filter(Boolean).pop()?.[0] ?? "P";
					return (
						<button
							type="button"
							key={session.sessionId}
							className={`no-drag group relative flex w-52 shrink-0 cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm transition-colors ${
								isActive ? "bg-border/80 text-ink" : "text-ink-dim hover:bg-hover hover:text-ink"
							}`}
							onClick={() => {
								switchSession(session.sessionId);
								setView("chat");
							}}
						>
							<span
								className={`flex h-4 w-4 shrink-0 items-center justify-center rounded text-[10px] font-semibold text-white ${
									isActive ? "bg-violet-500" : "bg-ink-faint"
								}`}
							>
								{letter.toUpperCase()}
							</span>
							<span className="relative min-w-0 flex-1">
								<span className="block truncate pr-6 text-left">
									{session.name ?? session.cwd.split("/").filter(Boolean).pop() ?? t("tabbar.untitled")}
								</span>
								<span className="invisible pointer-events-none absolute inset-y-0 right-0 w-7 bg-gradient-to-l from-hover via-hover/60 to-transparent group-hover:visible" />
								<span
									className="invisible absolute right-0 top-1/2 -translate-y-1/2 rounded-md bg-hover p-1 text-ink-dim opacity-0 transition-opacity hover:bg-border-strong/60 hover:text-ink-2 group-hover:visible group-hover:opacity-100"
									aria-hidden="true"
									onClick={(e) => {
										e.stopPropagation();
										void closeSession(session.sessionId);
									}}
									title={t("tabbar.close")}
								>
									<CloseIcon />
								</span>
							</span>
							{isStreaming && (
								<span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-violet-500" />
							)}
						</button>
					);
				})}
			</div>
			{view !== "projects" && (
				<button
					type="button"
					className="no-drag shrink-0 rounded-lg p-1.5 text-ink-dim transition-colors hover:bg-hover hover:text-ink"
					onClick={() => {
						void createSession();
						setView("chat");
					}}
					title={cwd ? t("tabbar.newSession") : t("tabbar.pickProjectFirst")}
					aria-label={t("tabbar.newSession")}
				>
					<ComposeIcon size={15} />
				</button>
			)}
		</div>
	);
}
