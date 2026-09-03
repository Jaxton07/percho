import type { SessionMeta } from "@percho/shared";
import { useState } from "react";
import { useT } from "../../i18n";
import { isDailyCwd } from "../../lib/daily";
import { useSessionsStore } from "../../stores/sessions";
import { useUiStore } from "../../stores/ui";
import { useUiPreferencesStore } from "../../stores/ui-preferences";
import { CloseIcon, CoffeeIcon, SubagentIcon } from "../icons";
import {
	type SessionStatus,
	sessionLetter,
	sessionProjectDir,
	sessionTitle,
	useSessionStatus,
} from "./session-status";

/**
 * 左侧会话轨道（可选交互，设置 → 外观 开关）：聊天页左侧垂直居中一列短线。
 * 定位基准是 tab bar 以下的**整列内容区**（App.tsx 把 rail 挂在 main + ApprovalDock 的父容器上，
 * 而非 main 内）——输入框（ApprovalDock）高度变化不压缩 rail 的居中参考系，轨道位置不随输入框漂移。
 * 悬停/聚焦时短线原地「膨胀」成悬浮胶囊（项目图标 + 会话标题，bg-surface + shadow-pop 全圆角 pill），
 * 相邻 ±1 变成一半大的胶囊（同样白底圆角，内容可见被裁断）、±2 变成迷你空胶囊，
 * 连续划过即 dock 式波浪（距离类 is-expanded/is-near-1/is-near-2 由 JS 按 expandedId 下标算出，
 * 比纯 CSS :has 链更易控——呼吸/内容显隐都要按距离精确开关）。
 * **行高同步分级撑开**（16 → 40/32/20px = 胶囊 + 留白，同时长同曲线）：按钮在文档流内，
 * 行一撑上下邻居自然让位，胶囊各行其道互不叠压；垂直居中列以悬停项为中心对称「分开」。
 * 只做「看 + 切换」——展开胶囊末尾有关闭 ×（仅展开态可见，同顶栏 group-hover 语义）；
 * 新建/排序仍走顶栏；关闭后顶栏/轨道同读 sessions 数组，天然双向同步。
 * 收起态是纯覆盖层（pointer-events-none），
 * 不挤压聊天布局；胶囊 absolute 于按钮垂直居中，随行高动但不参与布局。
 */
export function SessionRail() {
	const enabled = useUiPreferencesStore((s) => s.sessionRailEnabled);
	const view = useUiStore((s) => s.view);
	const sessions = useSessionsStore((s) => s.sessions);
	if (!enabled || view !== "chat" || sessions.length === 0) return null;
	return <SessionRailInner sessions={sessions} />;
}

function SessionRailInner({ sessions }: { sessions: SessionMeta[] }) {
	const t = useT();
	const activeSessionId = useSessionsStore((s) => s.activeSessionId);
	const switchSession = useSessionsStore((s) => s.switchSession);
	const setView = useUiStore((s) => s.setView);
	const [expandedId, setExpandedId] = useState<string | null>(null);
	const expandedIndex = sessions.findIndex((s) => s.sessionId === expandedId);

	return (
		<nav
			className="pointer-events-none absolute inset-y-0 left-0 z-30"
			aria-label={t("settings.sessionRail")}
		>
			{/* 容器只占视口外沿 288px 且不接指针：短线按钮列（w-8）单独可点可滚；胶囊向右浮出被 x 裁剪在容器内 */}
			<div className="h-full w-[288px] overflow-y-auto overflow-x-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
				{/* min-h-full + justify-center：不足一屏时垂直居中，超出时自然撑开从顶部滚动（justify-content:safe center 的经典替代）；无 gap、行高 16px 的紧凑间距 */}
				<div className="flex min-h-full flex-col justify-center py-6">
					{sessions.map((session, index) => (
						<RailItem
							key={session.sessionId}
							session={session}
							isActive={session.sessionId === activeSessionId}
							distance={expandedIndex === -1 ? null : Math.abs(index - expandedIndex)}
							onExpand={() => setExpandedId(session.sessionId)}
							onCollapse={() => setExpandedId((prev) => (prev === session.sessionId ? null : prev))}
							onSelect={() => {
								switchSession(session.sessionId);
								setView("chat");
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
 *  Enter/Space 走原生 click 切换 */
function RailItem({
	session,
	isActive,
	distance,
	onExpand,
	onCollapse,
	onSelect,
}: {
	session: SessionMeta;
	isActive: boolean;
	/** 与展开项的行距：0 = 自身展开，1/2 = 波浪跟涨档位，null = 无展开项 */
	distance: number | null;
	onExpand: () => void;
	onCollapse: () => void;
	onSelect: () => void;
}) {
	const t = useT();
	const status = useSessionStatus(session.sessionId);
	const closeSession = useSessionsStore((s) => s.closeSession);
	const title = sessionTitle(session, t("tabbar.untitled"), t("projects.daily"));
	const dir = sessionProjectDir(session);
	// 日常空间会话：头像余态换画布底 + 咖啡字形（状态色仍优先，同 TabPill 语义）
	const daily = isDailyCwd(session.cwd);
	const stateClass =
		distance === 0 ? "is-expanded" : distance === 1 ? "is-near-1" : distance === 2 ? "is-near-2" : "";
	return (
		<button
			type="button"
			className={`session-rail-item pointer-events-auto relative h-4 w-8 shrink-0 outline-none ${stateClass}`}
			onMouseEnter={onExpand}
			onMouseLeave={onCollapse}
			onFocus={onExpand}
			onBlur={onCollapse}
			onClick={onSelect}
			aria-label={dir && dir !== title ? `${title}（${dir}）` : title}
			aria-pressed={isActive}
		>
			<span className={`rail-capsule h-[2px] ${railLineClass(status, isActive)}`} aria-hidden="true">
				<span className="flex min-w-0 flex-1 items-center gap-2 px-2.5">
					<span
						className={`relative flex h-4 w-4 shrink-0 items-center justify-center rounded text-[10px] font-semibold ${
							session.readOnly
								? "bg-accent text-on-accent"
								: daily && status !== "attention" && status !== "working"
									? "border border-border-strong bg-canvas text-ink"
									: railAvatarClass(status, isActive)
						}`}
					>
						{session.readOnly ? (
							<SubagentIcon size={11} />
						) : daily ? (
							<CoffeeIcon size={10} />
						) : (
							sessionLetter(session).toUpperCase()
						)}
						{!session.readOnly && status === "done" && (
							<span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-green-500 ring-1 ring-surface" />
						)}
					</span>
					<span className="min-w-0 flex-1 truncate text-left text-sm text-ink">{title}</span>
					{/* 关闭 ×：仅展开态可见可点（CSS rail-close 控 opacity + pointer-events）；
					    span 而非 button（外层已是 button），stopPropagation 防触发切换；交互对齐顶栏 TabPill */}
					<span
						className="rail-close flex h-4 shrink-0 items-center justify-center overflow-hidden rounded text-ink-dim hover:text-ink"
						aria-hidden="true"
						onClick={(e) => {
							e.stopPropagation();
							void closeSession(session.sessionId);
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
