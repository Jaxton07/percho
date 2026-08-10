import type { SessionMeta } from "@pi-desktop/shared";
import { useEffect, useRef } from "react";
import { useT } from "../../i18n";
import { useSessionsStore } from "../../stores/sessions";
import { useTranscriptStore } from "../../stores/transcript";
import { useUiStore } from "../../stores/ui";
import { CloseIcon, ComposeIcon, GridIcon } from "../icons";

/** tab 状态（优先级递减）：等待权限 > 工作中 > 完成未读 > 空闲 */
type TabStatus = "attention" | "working" | "done" | "idle";

/** 单个会话 tab：独立订阅自己的运行状态（切走后状态不丢） */
function SessionTab({ session, isActive }: { session: SessionMeta; isActive: boolean }) {
	const t = useT();
	const switchSession = useSessionsStore((s) => s.switchSession);
	const closeSession = useSessionsStore((s) => s.closeSession);
	const setView = useUiStore((s) => s.setView);
	// selector 返回字符串原始值，引用稳定不触发多余渲染
	const status = useTranscriptStore((s): TabStatus => {
		const entry = s.bySession[session.sessionId];
		if (!entry) return "idle";
		if (entry.pendingPermissions.length > 0) return "attention";
		if (entry.agentActive) return "working";
		if (entry.unseenCompletion) return "done";
		return "idle";
	});
	// 图标字母 = 项目名（cwd 最后一段）首字母，与会话标题无关
	const letter = session.cwd.split("/").filter(Boolean).pop()?.[0] ?? "P";
	// 苹果式设计：状态全部收拢到头像图标（黑白色系，仅语义色保留琥珀/绿点），胶囊本体与标题完全不动
	const avatarClass =
		status === "attention"
			? "bg-amber-500"
			: status === "working"
				? "bg-ink tab-avatar-working"
				: isActive
					? "bg-ink"
					: "bg-ink-faint";
	return (
		<button
			type="button"
			className={`no-drag group relative flex w-52 shrink-0 cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm transition-colors ${
				isActive ? "bg-border/80 text-ink" : "text-ink-dim hover:bg-hover hover:text-ink"
			}`}
			onClick={() => {
				switchSession(session.sessionId);
				setView("chat");
			}}
		>
			<span
				className={`relative flex h-4 w-4 shrink-0 items-center justify-center rounded text-[10px] font-semibold text-on-ink ${avatarClass}`}
			>
				{letter.toUpperCase()}
				{status === "done" && (
					<span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-green-500 ring-1 ring-canvas" />
				)}
			</span>
			<span className="relative min-w-0 flex-1">
				<span className="block truncate pr-6 text-left">
					{session.name ?? session.cwd.split("/").filter(Boolean).pop() ?? t("tabbar.untitled")}
				</span>
				<span
					className="invisible absolute right-0 top-1/2 -translate-y-1/2 p-1 text-ink-dim opacity-0 transition-opacity hover:text-ink group-hover:visible group-hover:opacity-100"
					aria-hidden="true"
					onClick={(e) => {
						e.stopPropagation();
						void closeSession(session.sessionId);
					}}
				>
					<CloseIcon />
				</span>
			</span>
		</button>
	);
}

/** 顶栏：macOS hiddenInset 红绿灯左侧，会话 tab 从右排开 */
export function SessionTabBar() {
	const t = useT();
	const sessions = useSessionsStore((s) => s.sessions);
	const activeSessionId = useSessionsStore((s) => s.activeSessionId);
	const createSession = useSessionsStore((s) => s.createSession);
	const cwd = useSessionsStore((s) => s.cwd);
	const view = useUiStore((s) => s.view);
	const setView = useUiStore((s) => s.setView);
	const scrollerRef = useRef<HTMLDivElement>(null);

	// 正在查看的会话：完成未读标记立即清除（覆盖切 tab 与 projects ↔ chat 视图切换）
	useEffect(() => {
		if (activeSessionId && view === "chat") {
			useTranscriptStore.getState().markCompletionSeen(activeSessionId);
		}
	}, [activeSessionId, view]);

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
				aria-label={t("projects.title")}
			>
				<GridIcon />
			</button>
			<div
				ref={scrollerRef}
				className="flex min-w-0 flex-1 items-center gap-1 overflow-x-scroll [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
			>
				{sessions.map((session) => (
					<SessionTab
						key={session.sessionId}
						session={session}
						isActive={session.sessionId === activeSessionId}
					/>
				))}
			</div>
			{view !== "projects" && (
				<button
					type="button"
					className="no-drag shrink-0 rounded-lg p-1.5 text-ink-dim transition-colors hover:bg-hover hover:text-ink"
					onClick={() => {
						void createSession();
						setView("chat");
					}}
					aria-label={cwd ? t("tabbar.newSession") : t("tabbar.pickProjectFirst")}
				>
					<ComposeIcon size={15} />
				</button>
			)}
		</div>
	);
}
