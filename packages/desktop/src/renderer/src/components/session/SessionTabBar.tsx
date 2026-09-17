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
import { useCallback, useEffect, useRef, useState } from "react";
import { getPi } from "../../api";
import { useT } from "../../i18n";
import { isDailyCwd } from "../../lib/daily";
import { isDraftSessionId, partitionSessionsByPin, useSessionsStore } from "../../stores/sessions";
import { useToastsStore } from "../../stores/toasts";
import { useTranscriptStore } from "../../stores/transcript";
import { useUiStore } from "../../stores/ui";
import { useUiPreferencesStore } from "../../stores/ui-preferences";
import {
	CloseIcon,
	CoffeeIcon,
	DiffIcon,
	PencilIcon,
	PinIcon,
	PlusIcon,
	ProjectsIcon,
	SubagentIcon,
} from "../icons";
import { ContextMenu, type ContextMenuItem } from "../ui/ContextMenu";
import type { MenuAnchor } from "../ui/place-menu";
import { RenamePopover } from "./RenamePopover";
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

/** 触发元素的视口矩形 → 浮层锚点（菜单锚在下沿左对齐，定位规则见 place-menu） */
function anchorOfElement(el: Element): MenuAnchor {
	const rect = el.getBoundingClientRect();
	return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

/** 拖拽中的全局 cursor（指针常在胶囊外的间隙上，须挂在根元素） */
function setDraggingCursor(on: boolean): void {
	document.documentElement.classList.toggle("tab-dragging-cursor", on);
}

/** 右键菜单/重命名浮层共用的锚点状态：目标会话 + 触发胶囊的视口矩形 */
interface AnchorState {
	sessionId: string;
	anchor: MenuAnchor;
}

/** 胶囊视觉（presentational）：真实胶囊与拖拽 ghost 共用一份渲染。
 *  独立订阅自己的运行状态（切走后状态不丢）；苹果式设计：状态全收拢到头像图标
 *  （黑白色系，仅语义色保留琥珀/绿点），胶囊本体与标题完全不动 */
function TabPill({
	session,
	isActive,
	ghost = false,
	hidden = false,
	ghostWidth,
	contextOpen = false,
	buttonProps,
}: {
	session: SessionMeta;
	isActive: boolean;
	/** DragOverlay ghost：拾起视觉，无交互 */
	ghost?: boolean;
	/** 真实胶囊正被 ghost 接管：隐藏本体但保留布局槽位（邻居让位计算依赖它） */
	hidden?: boolean;
	/** ghost 的固定宽度（px）= 拾起瞬间真实胶囊的实测宽：拖拽全程保持原尺寸，
	    不回弹到 max-w-52 最大形态（标签多被压窄时，变大会显得很跳） */
	ghostWidth?: number | null;
	/** 右键菜单/重命名浮层打开中：右键没有 :hover，需显式保留触发态底色 */
	contextOpen?: boolean;
	buttonProps?: ComponentProps<"button">;
}) {
	const t = useT();
	const closeSession = useSessionsStore((s) => s.closeSession);
	// 置顶标记：顶栏会滚动、顺序会被拖动，必须有常显 glyph（不是只靠排序表达）
	const pinned = useUiPreferencesStore((s) => s.pinnedSessions.includes(session.sessionId));
	// 状态订阅与左侧会话轨道共用（优先级：审批 > 工作中 > 完成未读 > 空闲）
	const status = useSessionStatus(session.sessionId);
	// 头像字形 = 空间归属（日常 = 咖啡图标，项目 = 目录首字母）；只读子会话专属图标。
	// 余态底色：日常为画布底 + 细边框（白底黑字，与项目黑底白字反相）；状态色（审批琥珀/工作墨色）优先
	const daily = isDailyCwd(session.cwd);
	const letter = sessionLetter(session);
	const avatarClass = session.readOnly
		? "bg-accent text-on-accent"
		: status === "attention"
			? "bg-amber-500 text-on-ink"
			: status === "working"
				? "bg-ink text-on-ink tab-avatar-working"
				: daily
					? "border border-border-strong bg-canvas text-ink"
					: isActive
						? "bg-ink text-on-ink"
						: "bg-ink-faint text-on-ink";
	return (
		<button
			type="button"
			{...buttonProps}
			style={{
				touchAction: "none",
				...(ghost ? { width: ghostWidth ?? 208 } : null),
				...(hidden ? { opacity: 0 } : null),
			}}
			className={`no-drag tab-pill group relative flex ${ghost ? "" : "w-full"} cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm ${
				contextOpen
					? "bg-hover text-ink"
					: isActive
						? "bg-bubble text-ink"
						: "text-ink-dim hover:bg-hover hover:text-ink"
			} ${ghost ? "tab-dragging" : ""}`}
			onClick={ghost ? undefined : buttonProps?.onClick}
		>
			{pinned && !session.readOnly && (
				<span className="flex shrink-0 text-ink-faint" aria-hidden="true">
					<PinIcon size={11} />
				</span>
			)}
			<span
				className={`relative flex h-4 w-4 shrink-0 items-center justify-center rounded text-[10px] font-semibold ${avatarClass}`}
			>
				{session.readOnly ? (
					<SubagentIcon size={11} />
				) : daily ? (
					<CoffeeIcon size={10} />
				) : (
					letter.toUpperCase()
				)}
				{!session.readOnly && status === "done" && (
					<span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-green-500 ring-1 ring-canvas" />
				)}
			</span>
			<span className="relative min-w-0 flex-1">
				<span className="block truncate text-left">
					{sessionTitle(session, t("tabbar.untitled"), t("projects.daily"))}
				</span>
				{!ghost && (
					<>
						{/* hover 时尾部雾化渐变：盖住被叉叉重叠的文字尾，突出叉叉。
						   from 色必须与胶囊背景同款：active 背景是 bg-bubble，
						   直接 from-hover 在深色主题下会比 active 底色浅一档，渐变条会显成方形色块 */}
						<span
							aria-hidden="true"
							className={`pointer-events-none invisible absolute inset-y-0 right-0 w-7 bg-gradient-to-l to-transparent opacity-0 transition-opacity group-hover:visible group-hover:opacity-100 ${
								isActive ? "from-bubble" : "from-hover"
							}`}
						/>
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
					</>
				)}
			</span>
		</button>
	);
}

/** 单个会话 tab：几何层（useSortable 的 transform/transition）在 wrapper div 上按 dnd-kit 协议
 *  原样应用——transition 含 "none" 帧时绝不能覆盖成动画，那是 FLIP 布点帧（覆盖会造成落位回闪）；
 *  拖拽本体隐藏、由 DragOverlay 的 ghost 跟随指针（见 DRAG_MODIFIERS 注释） */
function SessionTab({
	session,
	isActive,
	contextOpen,
	onContextMenu,
}: {
	session: SessionMeta;
	isActive: boolean;
	/** 右键菜单/重命名浮层打开中（触发胶囊保持 hover 底） */
	contextOpen: boolean;
	onContextMenu: (sessionId: string, anchor: MenuAnchor) => void;
}) {
	const switchSession = useSessionsStore((s) => s.switchSession);
	const setView = useUiStore((s) => s.setView);
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
		id: session.sessionId,
		// 自定义让位/落位节奏；reduced-motion 传 null = dnd-kit 不再给出过渡串
		transition: prefersReducedMotion() ? null : { duration: 220, easing: SORT_EASE },
	});
	// 动态宽度：flex-1 均分剩余空间（每胶囊 ≤ max-w-52），空间不足时平均压缩（≥ min-w-24），
	// 全到最短后溢出由外层 scroller 滚动兜底；ghost 拖拽层用拾起时的实测宽度（ghostWidth），不参与 flex 布局
	return (
		<div
			ref={setNodeRef}
			data-tab-id={session.sessionId}
			className="min-w-24 max-w-52 flex-1"
			style={{
				transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
				transition: transition || undefined,
			}}
		>
			<TabPill
				session={session}
				isActive={isActive}
				hidden={isDragging}
				contextOpen={contextOpen}
				buttonProps={{
					...attributes,
					...listeners,
					// 右键不触发拖拽：PointerSensor 只认主键（button=0），此处再 preventDefault 掉系统菜单
					onContextMenu: (e) => {
						e.preventDefault();
						onContextMenu(session.sessionId, anchorOfElement(e.currentTarget));
					},
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
	const diffSidebarOpen = useUiStore((s) => s.diffSidebarOpen);
	const toggleDiffSidebar = useUiStore((s) => s.toggleDiffSidebar);
	const scrollerRef = useRef<HTMLDivElement>(null);
	const [activeId, setActiveId] = useState<string | null>(null);
	const pinnedSessions = useUiPreferencesStore((s) => s.pinnedSessions);
	const togglePin = useUiPreferencesStore((s) => s.togglePin);
	/** 右键菜单：目标会话 + 触发胶囊矩形（null = 关闭） */
	const [menu, setMenu] = useState<AnchorState | null>(null);
	/** 重命名浮层：与菜单同锚点，菜单选中后菜单卸载、浮层同帧展开 */
	const [renaming, setRenaming] = useState<AnchorState | null>(null);
	// 展示顺序：置顶区在左（拖拽只改 tabs.json 原始顺序，分区由纯函数表达）
	const orderedSessions = partitionSessionsByPin(sessions, pinnedSessions);
	const closeMenu = useCallback(() => setMenu(null), []);
	/** 打开胶囊右键菜单：draft（纯前端 id，后端没有该会话）与只读子会话（后端拒绝写）上的动作全都会失败，
	 *  所以**干脆不给菜单**（review B1：宁可没有入口，也不给必然弹 toast 的入口） */
	const openMenu = (sessionId: string, anchor: MenuAnchor) => {
		const session = sessions.find((s) => s.sessionId === sessionId);
		if (!session || session.readOnly || isDraftSessionId(sessionId)) return;
		setRenaming(null); // 换一个胶囊右键：覆盖旧菜单（同一时刻只存在一层）
		setMenu({ sessionId, anchor });
	};
	/** 取消置顶/置顶：新置顶挪到胶囊列表最左（视觉上直接进置顶区） */
	const handleTogglePin = (sessionId: string) => {
		const first = sessions[0];
		if (!pinnedSessions.includes(sessionId) && first && first.sessionId !== sessionId) {
			reorderSessions(sessionId, first.sessionId);
		}
		togglePin(sessionId);
	};
	/** 重命名落盘：活跃会话靠 session_info_changed 事件回流，历史会话无事件 → 本地立即更新（幂等） */
	const submitRename = (sessionId: string, name: string) => {
		if (!name) return; // 空值 = 保持原名（与系统重命名一致，不报错）
		getPi()
			.setSessionName({ sessionId, name })
			.then(() => useSessionsStore.getState().updateSessionName(sessionId, name))
			.catch((error) => {
				console.error("重命名失败", error);
				useToastsStore.getState().push("error", "toast.sessionRenameFailed");
			});
	};
	/** 右键菜单项：重命名 + 置顶（不可持久化的会话在 openMenu 就拦住了，这里只处理可写会话） */
	const contextMenuItems = (sessionId: string): ContextMenuItem[] => {
		return [
			{
				key: "rename",
				label: t("tabbar.rename"),
				icon: <PencilIcon size={13} />,
				onSelect: () => setRenaming(menu),
			},
			{
				key: "pin",
				label: pinnedSessions.includes(sessionId) ? t("tabbar.unpin") : t("tabbar.pin"),
				icon: <PinIcon size={13} />,
				onSelect: () => handleTogglePin(sessionId),
			},
		];
	};
	/** 被拖胶囊拾起时的实测宽度（px）：ghost 全程沿用，保持原胶囊尺寸。
	    不能读 active.rect.current.initial——dnd-kit 在 onDragStart 之后才填充该 ref，事件回调里恒为 null */
	const [dragWidth, setDragWidth] = useState<number | null>(null);
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
		setDragWidth(null);
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
					view === "projects" ? "bg-bubble text-ink" : "text-ink-dim hover:bg-hover hover:text-ink"
				}`}
				onClick={() => setView(view === "projects" ? "chat" : "projects")}
				aria-label={t("projects.title")}
			>
				<ProjectsIcon />
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
						setDragWidth(
							document
								.querySelector(`[data-tab-id="${CSS.escape(String(active.id))}"]`)
								?.getBoundingClientRect().width ?? null,
						);
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
					<SortableContext
						items={orderedSessions.map((s) => s.sessionId)}
						strategy={horizontalListSortingStrategy}
					>
						{orderedSessions.map((session) => (
							<SessionTab
								key={session.sessionId}
								session={session}
								isActive={session.sessionId === activeSessionId}
								contextOpen={
									menu?.sessionId === session.sessionId || renaming?.sessionId === session.sessionId
								}
								onContextMenu={(sessionId, anchor) => openMenu(sessionId, anchor)}
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
							<TabPill
								session={activeSession}
								isActive={activeSession.sessionId === activeSessionId}
								ghost
								ghostWidth={dragWidth}
							/>
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
					<PlusIcon size={18} />
				</button>
			)}
			{/* diff 侧栏开关：新会话按钮之后，active 态底色区分 */}
			{view !== "projects" && (
				<button
					type="button"
					className={`no-drag relative shrink-0 rounded-lg p-1.5 transition-colors ${
						diffSidebarOpen ? "bg-hover text-ink" : "text-ink-dim hover:bg-hover hover:text-ink"
					}`}
					onClick={toggleDiffSidebar}
					aria-label={t("diff.toggle")}
				>
					<DiffIcon size={16} />
				</button>
			)}
			{menu !== null && (
				<ContextMenu anchor={menu.anchor} items={contextMenuItems(menu.sessionId)} onClose={closeMenu} />
			)}
			{renaming !== null && (
				<RenamePopover
					anchor={renaming.anchor}
					value={sessions.find((s) => s.sessionId === renaming.sessionId)?.name ?? ""}
					onCommit={(name) => {
						// 先卸载浮层（退场动画已跑完），再落盘；失败只 toast，不回滚浮层
						setRenaming(null);
						submitRename(renaming.sessionId, name);
					}}
					onCancel={() => setRenaming(null)}
				/>
			)}
		</div>
	);
}
