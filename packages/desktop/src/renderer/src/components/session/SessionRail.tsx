import type { SessionMeta } from "@percho/shared";
import { useState } from "react";
import { useT } from "../../i18n";
import { isDailyCwd } from "../../lib/daily";
import { useListShift } from "../../lib/use-list-shift";
import { useWorkspaceRemoval } from "../../lib/workspace-actions";
import { useProjectsStore } from "../../stores/projects";
import { resolveWorkspaceSessions, useSessionWorkspaceStore } from "../../stores/session-workspace";
import { useSessionsStore } from "../../stores/sessions";
import { useUiPreferencesStore } from "../../stores/ui-preferences";
import { CloseIcon, CoffeeIcon, PinIcon } from "../icons";
import {
	type SessionStatus,
	sessionLetter,
	sessionProjectDir,
	sessionTitle,
	useSessionStatus,
} from "./session-status";

/**
 * 左侧会话轨道（设置 → 外观「左侧会话轨道」，默认关）：聊天列左缘垂直居中一列短线。
 *
 * 数据源与顶栏**同一份临时会话工作区**（`resolveWorkspaceSessions`：tabs 优先、目录兜底）——
 * 因此内存策略卸载掉的成员照样在，顺序就是工作区顺序。点击未加载成员走按需打开，
 * × = 从工作区移出（与顶栏同一个 `useWorkspaceRemoval`，不关会话、不取消置顶）。
 *
 * 定位基准是 tab bar 以下的**整列内容区**（App.tsx 把 rail 挂在 main + ApprovalDock 的父容器上，
 * 而非 main 内）——输入框（ApprovalDock）高度变化不压缩 rail 的居中参考系，轨道位置不随输入框漂移。
 * 悬停/聚焦时短线原地「膨胀」成悬浮胶囊（项目图标 + 会话标题，bg-surface + shadow-pop 全圆角 pill），
 * 相邻 ±1 变成一半大的胶囊（同样白底圆角，内容可见被裁断）、±2 变成迷你空胶囊，
 * 连续划过即 dock 式波浪（距离类 is-expanded/is-near-1/is-near-2 由 JS 按 expandedId 下标算出）。
 * **行高同步分级撑开**（16 → 40/32/20px = 胶囊 + 留白，同时长同曲线）：按钮在文档流内，
 * 行一撑上下邻居自然让位，胶囊各行其道互不叠压；垂直居中列以悬停项为中心对称「分开」。
 * 收起态是纯覆盖层（pointer-events-none），不挤压聊天布局；胶囊 absolute 于按钮垂直居中。
 * 命中区宽 24px（w-6）：窄窗口（760px）下正文左边缘在 x≈264，24px 的条带正好不蓋住正文；
 * 比它更宽的条带会在窄窗口里抢掉正文首字符的点击/选字（阶段 3 CDP 实测）。
 * 动画细节与档位曲线见 styles/globals.css 的 `.session-rail-item*`（v10 定稿搬回）。
 */
export function SessionRail() {
	const enabled = useUiPreferencesStore((s) => s.sessionRailEnabled);
	const members = useSessionWorkspaceStore((s) => s.members);
	const sessions = useSessionsStore((s) => s.sessions);
	const allSessions = useProjectsStore((s) => s.allSessions);
	if (!enabled || members.length === 0) return null;
	return <SessionRailInner members={members} sessions={sessions} allSessions={allSessions} />;
}

/** 轨道项 DOM 查询：键盘移出后要把焦点挪到邻居，不能丢在已删节点上 */
function railItemElement(sessionId: string): HTMLElement | null {
	return document.querySelector<HTMLElement>(`[data-rail-session-id="${sessionId}"]`);
}

function SessionRailInner({
	members,
	sessions,
	allSessions,
}: {
	members: ReturnType<typeof useSessionWorkspaceStore.getState>["members"];
	sessions: readonly SessionMeta[];
	allSessions: readonly SessionMeta[];
}) {
	const t = useT();
	const activeSessionId = useSessionsStore((s) => s.activeSessionId);
	const openSession = useProjectsStore((s) => s.openSession);
	const removeFromWorkspace = useWorkspaceRemoval();
	const [expandedId, setExpandedId] = useState<string | null>(null);
	/** 增删成员时让上下邻居滑动到位（FLIP，与顶栏同一套；波浪的高度变化不算集合变化、不触发） */
	const listShiftRef = useListShift();
	// 展示集（工作区顺序）：顺序与顶栏一致，未加载成员靠目录投影补 meta
	const items = resolveWorkspaceSessions(members, sessions, allSessions);
	const expandedIndex = items.findIndex((s) => s.sessionId === expandedId);

	/**
	 * 移出工作区（× 与键盘 Delete/Backspace 共用）：
	 * 语义与顶栏完全一致（`useWorkspaceRemoval` 一份实现），额外把**焦点挪到邻居** ——
	 * 键盘用户不能因为自己移出了当前项、DOM 被删而丢失焦点（未删完时聚焦原下标处的项）。
	 */
	const removeAt = (session: SessionMeta, index: number) => {
		const member = members.find((m) => m.sessionId === session.sessionId);
		if (!member) return;
		const remaining = items.filter((s) => s.sessionId !== session.sessionId);
		const focusIndex = Math.max(0, Math.min(index, remaining.length - 1));
		const nextId = remaining[focusIndex]?.sessionId ?? null;
		removeFromWorkspace(member);
		if (nextId) requestAnimationFrame(() => railItemElement(nextId)?.focus());
	};

	return (
		<nav className="pointer-events-none absolute inset-y-0 left-0 z-30" aria-label={t("rail.ariaLabel")}>
			{/* 容器只占视口外沿 288px 且不接指针：短线按钮列（w-8）单独可点可滚；胶囊向右浮出被 x 裁剪在容器内 */}
			<div
				ref={listShiftRef}
				className="h-full w-[288px] overflow-y-auto overflow-x-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
			>
				{/* min-h-full + justify-center：不足一屏时垂直居中，超出时自然撑开从顶部滚动；无 gap、行高 16px 的紧凑间距 */}
				<div className="flex min-h-full flex-col justify-center py-6">
					{items.map((session, index) => (
						<RailItem
							key={session.sessionId}
							session={session}
							isActive={session.sessionId === activeSessionId}
							distance={expandedIndex === -1 ? null : Math.abs(index - expandedIndex)}
							onExpand={() => setExpandedId(session.sessionId)}
							onCollapse={() => setExpandedId((prev) => (prev === session.sessionId ? null : prev))}
							onSelect={() => void openSession(session)}
							onRemove={() => removeAt(session, index)}
							onMoveFocus={(delta) => {
								const next = items[Math.min(items.length - 1, Math.max(0, index + delta))]?.sessionId;
								if (next) railItemElement(next)?.focus();
							}}
						/>
					))}
				</div>
			</div>
		</nav>
	);
}

/** 单条短线：胶囊与短线是同一个元素（rail-capsule），收起 = 3px 状态线（子元素透明裁剪），
 *  展开 = 悬浮胶囊（图标 + 标题淡入）。键盘可达：聚焦即展开（展开本身即焦点指示），
 *  Enter/Space 走原生 click 切换；展开态末尾的 × 只移出工作区 */
function RailItem({
	session,
	isActive,
	distance,
	onExpand,
	onCollapse,
	onSelect,
	onRemove,
	onMoveFocus,
}: {
	session: SessionMeta;
	isActive: boolean;
	/** 与展开项的行距：0 = 自身展开，1/2 = 波浪跟涨档位，null = 无展开项 */
	distance: number | null;
	onExpand: () => void;
	onCollapse: () => void;
	onSelect: () => void;
	onRemove: () => void;
	/** 方向键在条目间移动焦点（纵向列表的惯例）：由父层算邻居并聚焦 */
	onMoveFocus: (delta: 1 | -1) => void;
}) {
	const t = useT();
	const status = useSessionStatus(session.sessionId);
	// 置顶标记：展开胶囊里也画（收起态是状态短线，不放图钉）；与顶栏同一枚 glyph 风格
	const pinned = useUiPreferencesStore((s) => s.pinnedSessions.includes(session.sessionId));
	const title = sessionTitle(session, t("tabbar.untitled"), t("projects.daily"));
	const dir = sessionProjectDir(session);
	// 日常空间会话：头像余态换画布底 + 咖啡字形（状态色仍优先，同 TabPill 语义）
	const daily = isDailyCwd(session.cwd);
	const stateClass =
		distance === 0 ? "is-expanded" : distance === 1 ? "is-near-1" : distance === 2 ? "is-near-2" : "";
	return (
		<button
			type="button"
			data-rail-session-id={session.sessionId}
			data-shift-key={session.sessionId}
			className={`session-rail-item pointer-events-auto relative h-4 w-6 shrink-0 outline-none ${stateClass}`}
			onMouseEnter={onExpand}
			onMouseLeave={onCollapse}
			onFocus={onExpand}
			onBlur={onCollapse}
			onClick={onSelect}
			/** 键盘路径：
			 *  - ArrowUp/ArrowDown = 在条目间移动焦点（= `rail.ariaLabel` 承诺的行为，CDP 有断言）
			 *  - Delete/Backspace = 移出工作区（与 × 同一实现），使只用键盘也能逐条清理
			 *  不用 Enter/Space（那是切换会话，原生 click 已覆盖） */
			onKeyDown={(e) => {
				if (e.key === "ArrowDown" || e.key === "ArrowUp") {
					e.preventDefault();
					onMoveFocus(e.key === "ArrowDown" ? 1 : -1);
					return;
				}
				if (e.key !== "Delete" && e.key !== "Backspace") return;
				e.preventDefault();
				e.stopPropagation();
				onRemove();
			}}
			aria-keyshortcuts="ArrowUp ArrowDown Delete Backspace"
			aria-label={dir && dir !== title ? `${title}（${dir}）` : title}
			aria-pressed={isActive}
		>
			<span className={`rail-capsule h-[2px] ${railLineClass(status, isActive)}`} aria-hidden="true">
				<span className="flex min-w-0 flex-1 items-center gap-2 px-2.5">
					{pinned && (
						<span className="flex shrink-0 text-ink-faint" aria-hidden="true">
							<PinIcon size={11} />
						</span>
					)}
					<span
						className={`relative flex h-4 w-4 shrink-0 items-center justify-center rounded text-ui-10 font-semibold ${
							daily && status !== "attention" && status !== "working"
								? "border border-border-strong bg-canvas text-ink"
								: railAvatarClass(status, isActive)
						}`}
					>
						{daily ? <CoffeeIcon size={10} /> : sessionLetter(session).toUpperCase()}
						{status === "done" && (
							<span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-green-500 ring-1 ring-surface" />
						)}
					</span>
					<span className="min-w-0 flex-1 truncate text-left text-ui-14 leading-[calc(1.25_/_0.875)] text-ink">
						{title}
					</span>
					{/* ×（仅展开态可见可点，CSS rail-close 控 opacity + pointer-events）：span 而非 button
					    （外层已是 button），stopPropagation 防触发切换；语义 = 移出工作区（不关会话）。
					    键盘等价操作是条目上的 Delete/Backspace（见外层 onKeyDown + aria-keyshortcuts） */}
					<span
						className="rail-close flex h-4 shrink-0 items-center justify-center overflow-hidden rounded text-ink-dim hover:text-ink"
						aria-hidden="true"
						title={t("tabbar.removeFromWorkspace")}
						onClick={(e) => {
							e.stopPropagation();
							onRemove();
						}}
					>
						<CloseIcon />
					</span>
				</span>
			</span>
		</button>
	);
}

/** 收起态细线（优先级同顶栏）：审批 = 琥珀 / 工作中 = 墨色呼吸 / 完成未读 = 绿 / 当前会话 = 更长更深的墨色。
 *  直角 2px 细线（codex 风），三档宽度：空闲 12 / 状态 16 / 当前 20 */
function railLineClass(status: SessionStatus, isActive: boolean): string {
	if (status === "attention") return "w-4 bg-amber-500";
	if (status === "working") return "w-4 bg-ink rail-working";
	if (status === "done") return "w-4 bg-green-500";
	return isActive ? "w-5 bg-ink" : "w-3 bg-ink-faint";
}

/** 展开态胶囊头像（与 TabPill 完全同语义）：审批琥珀 / 工作中墨色呼吸 / 完成未读绿点角标 / 当前更深 */
function railAvatarClass(status: SessionStatus, isActive: boolean): string {
	if (status === "attention") return "bg-amber-500 text-on-ink";
	if (status === "working") return "bg-ink text-on-ink tab-avatar-working";
	return isActive ? "bg-ink text-on-ink" : "bg-ink-faint text-on-ink";
}
