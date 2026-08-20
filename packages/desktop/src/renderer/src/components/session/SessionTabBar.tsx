import type { DragEndEvent, Modifier } from "@dnd-kit/core";
import {
	closestCenter,
	DndContext,
	DragOverlay,
	KeyboardSensor,
	PointerSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import { restrictToHorizontalAxis, restrictToParentElement } from "@dnd-kit/modifiers";
import {
	horizontalListSortingStrategy,
	SortableContext,
	sortableKeyboardCoordinates,
	useSortable,
} from "@dnd-kit/sortable";
import type { SessionMeta } from "@percho/shared";
import type { ComponentProps } from "react";
import { useEffect, useRef, useState } from "react";
import { getPi } from "../../api";
import { useT } from "../../i18n";
import { useSessionsStore } from "../../stores/sessions";
import { useTranscriptStore } from "../../stores/transcript";
import { useUiStore } from "../../stores/ui";
import { CloseIcon, ComposeIcon, GridIcon } from "../icons";
import { sessionLetter, sessionTitle, useSessionStatus } from "./session-status";
import { UpdateButton } from "./UpdateButton";

/** 拖拽让位/落位的减速曲线（浏览器标签同款手感） */
const SORT_EASE = "cubic-bezier(0.2, 0, 0, 1)";

/** 拖拽轴锁定（挂在 DragOverlay 上）：只许水平移动，且钳在 tab 条容器内（浏览器标签行为）。
 *  必须挂 overlay：ghost 是 fixed 定位不参与滚动区域；若让指针 transform 落在流内胶囊上，
 *  Chromium 会把 transform 后的盒子计入滚动容器的可滚动区域 → 拖到右缘 scrollWidth 持续增长，
 *  auto-scroll 追着新边缘滚 = 无限右滚（左侧有 scrollLeft>=0 天然边界所以没事） */
const DRAG_MODIFIERS: Modifier[] = [restrictToHorizontalAxis, restrictToParentElement];

/** ghost 落位动画：fade 回到槽位（duration 用自己的曲线节奏） */
const DROP_ANIMATION = { duration: 180, easing: SORT_EASE };

const prefersReducedMotion = (): boolean => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** 拖拽中的全局 cursor（指针常在胶囊外的间隙上，须挂在根元素） */
function setDraggingCursor(on: boolean): void {
	document.documentElement.classList.toggle("tab-dragging-cursor", on);
}

/** 胶囊视觉（presentational）：真实胶囊与拖拽 ghost 共用一份渲染。
 *  独立订阅自己的运行状态（切走后状态不丢）；苹果式设计：状态全收拢到头像图标
 *  （黑白色系，仅语义色保留琥珀/绿点），胶囊本体与标题完全不动 */
function TabPill({
	session,
	isActive,
	ghost = false,
	hidden = false,
	buttonProps,
}: {
	session: SessionMeta;
	isActive: boolean;
	/** DragOverlay ghost：拾起视觉，无交互 */
	ghost?: boolean;
	/** 真实胶囊正被 ghost 接管：隐藏本体但保留布局槽位（邻居让位计算依赖它） */
	hidden?: boolean;
	buttonProps?: ComponentProps<"button">;
}) {
	const t = useT();
	const closeSession = useSessionsStore((s) => s.closeSession);
	// 状态订阅与左侧会话轨道共用（优先级：审批 > 工作中 > 完成未读 > 空闲）
	const status = useSessionStatus(session.sessionId);
	// 图标字母 = 项目名（cwd 最后一段）首字母，与会话标题无关
	const letter = sessionLetter(session);
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
			{...buttonProps}
			style={{ touchAction: "none", ...(hidden ? { opacity: 0 } : null) }}
			className={`no-drag tab-pill group relative flex w-52 cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm ${
				isActive ? "bg-border/80 text-ink" : "text-ink-dim hover:bg-hover hover:text-ink"
			} ${ghost ? "tab-dragging" : ""}`}
			onClick={ghost ? undefined : buttonProps?.onClick}
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
				<span className="block truncate pr-6 text-left">{sessionTitle(session, t("tabbar.untitled"))}</span>
				{!ghost && (
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
				)}
			</span>
		</button>
	);
}

/** 单个会话 tab：几何层（useSortable 的 transform/transition）在 wrapper div 上按 dnd-kit 协议
 *  原样应用——transition 含 "none" 帧时绝不能覆盖成动画，那是 FLIP 布点帧（覆盖会造成落位回闪）；
 *  拖拽本体隐藏、由 DragOverlay 的 ghost 跟随指针（见 DRAG_MODIFIERS 注释） */
function SessionTab({ session, isActive }: { session: SessionMeta; isActive: boolean }) {
	const switchSession = useSessionsStore((s) => s.switchSession);
	const setView = useUiStore((s) => s.setView);
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
		id: session.sessionId,
		// 自定义让位/落位节奏；reduced-motion 传 null = dnd-kit 不再给出过渡串
		transition: prefersReducedMotion() ? null : { duration: 220, easing: SORT_EASE },
	});
	return (
		<div
			ref={setNodeRef}
			className="shrink-0"
			style={{
				transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
				transition: transition || undefined,
			}}
		>
			<TabPill
				session={session}
				isActive={isActive}
				hidden={isDragging}
				buttonProps={{
					...attributes,
					...listeners,
					onClick: () => {
						switchSession(session.sessionId);
						setView("chat");
					},
				}}
			/>
		</div>
	);
}

/** 顶栏：macOS hiddenInset 红绿灯在左（预留 pl-20）；Windows 系统按钮覆盖层在右（预留 pr-[140px]）；
 *  Linux 原生框架两侧均不预留。会话 tab 从左排开，可拖拽排序（浏览器标签式） */
export function SessionTabBar() {
	const t = useT();
	const platform = getPi().platform;
	const sessions = useSessionsStore((s) => s.sessions);
	const activeSessionId = useSessionsStore((s) => s.activeSessionId);
	const createDraftSession = useSessionsStore((s) => s.createDraftSession);
	const reorderSessions = useSessionsStore((s) => s.reorderSessions);
	const cwd = useSessionsStore((s) => s.cwd);
	const view = useUiStore((s) => s.view);
	const setView = useUiStore((s) => s.setView);
	const scrollerRef = useRef<HTMLDivElement>(null);
	const [activeId, setActiveId] = useState<string | null>(null);
	const activeSession = sessions.find((s) => s.sessionId === activeId);
	// 拖拽期间：顶栏整体退出窗口拖拽区（胶囊间隙本是 drag-region，指针扫过会被 macOS 当拖窗口吞事件）
	const dragging = activeId !== null;
	// 5px 激活距离：原地点击/关胶囊不触发拖拽；键盘传感器支持 Space 抬起 + 左右键移动
	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
		useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
	);
	const endDrag = () => {
		setActiveId(null);
		setDraggingCursor(false);
	};

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

	// macOS 左侧为红绿灯留 80px；Windows 右侧为窗口按钮覆盖层留 140px（3 × 46px 取整）
	const chromePadding =
		platform === "darwin" ? "pl-20 pr-3" : platform === "win32" ? "pl-3 pr-[140px]" : "pl-3 pr-3";

	return (
		<div
			className={`${dragging ? "" : "drag-region"} flex h-12 shrink-0 items-center gap-1 border-b border-border bg-canvas ${chromePadding}`}
		>
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
				<DndContext
					sensors={sensors}
					collisionDetection={closestCenter}
					onDragStart={({ active }) => {
						setActiveId(String(active.id));
						setDraggingCursor(true);
					}}
					onDragEnd={({ active, over }: DragEndEvent) => {
						endDrag();
						if (over && active.id !== over.id) {
							reorderSessions(String(active.id), String(over.id));
						}
					}}
					onDragCancel={endDrag}
				>
					<SortableContext items={sessions.map((s) => s.sessionId)} strategy={horizontalListSortingStrategy}>
						{sessions.map((session) => (
							<SessionTab
								key={session.sessionId}
								session={session}
								isActive={session.sessionId === activeSessionId}
							/>
						))}
					</SortableContext>
					{/* 拖拽 ghost：fixed 定位（不参与滚动区域 → 不会撑大 scrollWidth），
					    落位时 fade 回槽位，真实胶囊同时 fade in（.tab-pill 的 opacity 过渡） */}
					<DragOverlay
						modifiers={DRAG_MODIFIERS}
						dropAnimation={prefersReducedMotion() ? null : DROP_ANIMATION}
					>
						{activeSession ? (
							<TabPill session={activeSession} isActive={activeSession.sessionId === activeSessionId} ghost />
						) : null}
					</DragOverlay>
				</DndContext>
			</div>
			<UpdateButton />
			{view !== "projects" && (
				<button
					type="button"
					className="no-drag shrink-0 rounded-lg p-1.5 text-ink-dim transition-colors hover:bg-hover hover:text-ink"
					onClick={() => {
						// 只建内存 draft tab（空 tab 重启自动消失）；发送首条消息时才真正创建后端会话
						createDraftSession();
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
