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
import { useCallback, useEffect, useState } from "react";
import { getPi } from "../../api";
import { useT } from "../../i18n";
import { COMPOSER_FOCUS_EVENT } from "../../stores/drafts";
import { useProjectsStore } from "../../stores/projects";
import { selectBarSessions, useSessionsStore } from "../../stores/sessions";
import { useTranscriptStore } from "../../stores/transcript";
import { useUiStore } from "../../stores/ui";
import { useUiPreferencesStore } from "../../stores/ui-preferences";
import { CloseIcon, DiffIcon, PanelLeftIcon, PinIcon, PlusIcon } from "../icons";
import { ContextMenu, type ContextMenuItem } from "../ui/ContextMenu";
import type { MenuAnchor } from "../ui/place-menu";
import { RenamePopover } from "./RenamePopover";
import { SessionAvatar } from "./SessionAvatar";
import { canOpenSessionMenu, renameSession, sessionMenuItems } from "./session-menu";
import { sessionTitle, useSessionStatus } from "./session-status";
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
	// v9：叉叉 = 取消置顶 + 从顶栏清除（会话不删、tab 也不关）。顶栏严格只放置顶会话，
	// draft 已不再进顶栏（其名题与丢弃入口都在左栏，见 spec D1/D3）
	const unpin = useUiPreferencesStore((s) => s.unpin);
	// 置顶标记：顶栏会滚动、顺序会被拖动，必须有常显 glyph（不是只靠排序表达）
	const pinned = useUiPreferencesStore((s) => s.pinnedSessions.includes(session.sessionId));
	// 状态订阅与左侧会话轨道共用（优先级：审批 > 工作中 > 完成未读 > 空闲）；头像渲染也共用（SessionAvatar）
	const status = useSessionStatus(session.sessionId);
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
			<SessionAvatar session={session} status={status} isActive={isActive} dotRing="ring-canvas" />
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
							/* 胶囊本体是 button，这里不能再塞 button（嵌套非法）→ 用 codebase 同款做法：装饰 span + aria-hidden，
							   语义提示走原生 title（同 SessionRow），语义入口靠胶囊右键菜单的「取消置顶」 */
							title={t("tabbar.unpinFromBar")}
							onClick={(e) => {
								e.stopPropagation();
								unpin(session.sessionId);
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
	// 顶栏里可能是「已置顶但 tab 未打开」的会话，点击要能把它开起来（openSession 一条路兼容两种情况）
	const openSession = useProjectsStore((s) => s.openSession);
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
					onClick: () => void openSession(session),
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
	const activateNewSessionDraft = useSessionsStore((s) => s.activateNewSessionDraft);

	const cwd = useSessionsStore((s) => s.cwd);
	const diffSidebarOpen = useUiStore((s) => s.diffSidebarOpen);
	const toggleDiffSidebar = useUiStore((s) => s.toggleDiffSidebar);
	const sidebarCollapsed = useUiPreferencesStore((s) => s.sidebarCollapsed);
	const toggleSidebarCollapsed = useUiPreferencesStore((s) => s.toggleSidebarCollapsed);
	const [activeId, setActiveId] = useState<string | null>(null);
	/** 胶囊区横向滚动的滚轮监听：用回调 ref 而非 useEffect + ref 对象——悬浮模式下 scroller 不渲染，
	 *  回调 ref 在挂载/卸载时天然重挂监听（React 19 支持返回清理函数，不用手写依赖数组） */
	const attachScroller = useCallback((el: HTMLDivElement | null) => {
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

	const pinnedSessions = useUiPreferencesStore((s) => s.pinnedSessions);
	const reorderPinned = useUiPreferencesStore((s) => s.reorderPinned);
	// v9：顶栏常驻，这个开关只决定「顶栏要不要出置顶会话胶囊」
	const barSessionsVisible = useUiPreferencesStore((s) => s.barSessionsVisible);
	// 历史列表：顶栏要能展示「已置顶但 tab 未打开」的会话，它们只存在于历史里
	const allSessions = useProjectsStore((s) => s.allSessions);
	/** 右键菜单：目标会话 + 触发胶囊矩形（null = 关闭） */
	const [menu, setMenu] = useState<AnchorState | null>(null);
	/** 重命名浮层：与菜单同锚点，菜单选中后菜单卸载、浮层同帧展开 */
	const [renaming, setRenaming] = useState<AnchorState | null>(null);
	// 展示集（v8）：置顶表驱动（不看 tab 开没开）+ 未命名 draft；v9：设置里的开关只控制「显不显这些胶囊」
	const barSessions = barSessionsVisible ? selectBarSessions(sessions, pinnedSessions, allSessions) : [];
	const closeMenu = useCallback(() => setMenu(null), []);
	/** 打开胶囊右键菜单：draft（纯前端 id，后端没有该会话）与只读子会话（后端拒绝写）上的动作全都会失败，
	 *  所以**干脆不给菜单**（review B1：宁可没有入口，也不给必然弹 toast 的入口） */
	const openMenu = (sessionId: string, anchor: MenuAnchor) => {
		if (!canOpenSessionMenu(sessions.find((s) => s.sessionId === sessionId))) return;
		setRenaming(null); // 换一个胶囊右键：覆盖旧菜单（同一时刻只存在一层）
		setMenu({ sessionId, anchor });
	};
	/** 右键菜单项（重命名 + 置顶/取消置顶）：规则与动作在 components/session/session-menu.tsx，与悬浮面板共用一份 */
	const contextMenuItems = (sessionId: string): ContextMenuItem[] =>
		sessionMenuItems(t, {
			sessionId,
			pinned: pinnedSessions.includes(sessionId),
			onRename: () => setRenaming(menu),
		});
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

	// 正在查看的会话：完成未读标记立即清除
	useEffect(() => {
		if (activeSessionId) {
			useTranscriptStore.getState().markCompletionSeen(activeSessionId);
		}
	}, [activeSessionId]);

	// macOS 左侧为红绿灯留 80px；Windows 右侧为窗口按钮覆盖层留 140px（3 × 46px 取整）
	const chromePadding =
		platform === "darwin" ? "pl-20 pr-3" : platform === "win32" ? "pl-3 pr-[140px]" : "pl-3 pr-3";

	return (
		<div
			className={`${dragging ? "" : "drag-region"} flex h-12 shrink-0 items-center gap-1 border-b border-border bg-canvas ${chromePadding}`}
		>
			{/* 左栏开合（右栏 diff 图标的镜像）：开态底色区分；左栏收起后展开也靠它，设置入口就在左栏里 */}
			<button
				type="button"
				className={`no-drag shrink-0 rounded-lg p-1.5 transition-colors ${
					sidebarCollapsed ? "text-ink-dim hover:bg-hover hover:text-ink" : "bg-hover text-ink"
				}`}
				onClick={toggleSidebarCollapsed}
				aria-label={sidebarCollapsed ? t("sidebar.expand") : t("sidebar.collapse")}
			>
				<PanelLeftIcon size={16} />
			</button>
			{/* 胶囊区（含拖拽排序）：flex-1 吃掉中间剩余宽度 */}
			<div
				ref={attachScroller}
				className="flex min-w-0 flex-1 items-center gap-1 overflow-x-scroll [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
			>
				{/* 空态提示（v8）：顶栏只放置顶会话，初学者很容易以为顶栏坏了；
				   开关关掉时不提示（那是用户的明确选择，不是“空”） */}
				{barSessionsVisible && barSessions.length === 0 && (
					<span className="min-w-0 truncate pl-1 text-[12px] text-ink-faint">
						{t("tabbar.pinnedOnlyHint")}
					</span>
				)}
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
							// v8：拖的是置顶表顺序（顶栏内容 = 置顶表），不再动 tabs.json
							reorderPinned(String(active.id), String(over.id));
						}
					}}
					onDragCancel={endDrag}
				>
					<SortableContext
						items={barSessions.map((s) => s.sessionId)}
						strategy={horizontalListSortingStrategy}
					>
						{barSessions.map((session) => (
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
			<button
				type="button"
				className="no-drag shrink-0 rounded-lg p-1.5 text-ink-dim transition-colors hover:bg-hover hover:text-ink"
				onClick={() => {
					// 单例 draft：已有 draft 就回到它（内容与配置一律保留，并聚焦输入框）；
					// 没有 draft（转正刚消费掉、或启动首帧）才新建一份
					const hadDraft = useSessionsStore.getState().newSessionDraft !== null;
					activateNewSessionDraft();
					if (hadDraft) window.dispatchEvent(new CustomEvent(COMPOSER_FOCUS_EVENT));
				}}
				aria-label={cwd ? t("tabbar.newSession") : t("tabbar.pickProjectFirst")}
			>
				<PlusIcon size={18} />
			</button>
			{/* diff 侧栏开关：新会话按钮之后，active 态底色区分 */}
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
						renameSession(renaming.sessionId, name);
					}}
					onCancel={() => setRenaming(null)}
				/>
			)}
		</div>
	);
}
