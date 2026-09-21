import type { SessionMeta } from "@percho/shared";
import type { SidebarSession } from "../../lib/sidebar-groups";
import type { MenuAnchor } from "../ui/place-menu";
import { SessionRow } from "./SessionRow";

/** 会话列表的空间上限：8 个完整会话行（不露半行，避免把裁切误认成布局错误） */
export const SIDEBAR_SESSION_LIST_MAX_ROWS = 8;
/** 会话行高的布局常量（与 `SessionRow` 的固定行高 `h-[31px]` 配套；改行高要同时改两处） */
export const SIDEBAR_SESSION_ROW_HEIGHT = 31;

/**
 * 分组的会话列表（日常与每个项目共用）：限高 + 组内独立滚动。
 *
 * 内外滚动归属靠**原生嵌套滚动**表达，不拦 wheel、不手改 scrollTop：
 * - 列表用 `overflow-y-auto`，滚轮命中列表内容区时只滚它自己；
 * - **只有真的会溢出（> 8 行）时才挂 `overscroll-y-contain`** —— 实测（2026-09-21，dev + CDP 真实 wheel）
 *   给「不溢出的滚动容器」挂 contain 会把滚轮整个吞掉、外层一动不动（项目标题区之外的导航就此失灵），
 *   所以 contain 与 `data-scrollable` 共用同一个判据，不给探针留分叉的可能；
 * - 项目标题行由调用方渲染在本组件**之外**，标题上的滚轮自然交给外层侧栏。
 *
 * 纯 props 驱动：不读 store、不排序、不管展开态与菜单状态（那些属于 `SidebarGroup`）。
 */
export function SidebarSessionList({
	sessions,
	activeSessionId,
	emptyLabel,
	onSelect,
	onContextMenu,
}: {
	sessions: readonly SidebarSession[];
	activeSessionId: string | null;
	emptyLabel: string;
	onSelect: (session: SessionMeta) => void;
	onContextMenu: (session: SessionMeta, anchor: MenuAnchor) => void;
}) {
	const scrollable = sessions.length > SIDEBAR_SESSION_LIST_MAX_ROWS;
	if (sessions.length === 0) {
		return <p className="py-1 pl-[30px] text-[12px] text-ink-faint">{emptyLabel}</p>;
	}
	return (
		<div
			// 可测试性只读属性（验收脚本按它们定位并测量，纯属性，不影响视觉/交互）
			data-sidebar-session-list=""
			data-scrollable={scrollable ? "true" : "false"}
			className={`overflow-x-hidden overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${
				scrollable ? "overscroll-y-contain" : ""
			}`}
			style={{ maxHeight: SIDEBAR_SESSION_LIST_MAX_ROWS * SIDEBAR_SESSION_ROW_HEIGHT }}
		>
			{sessions.map(({ session, pinned }) => (
				<SessionRow
					key={session.sessionId}
					session={session}
					active={session.sessionId === activeSessionId}
					pinned={pinned}
					onSelect={() => onSelect(session)}
					onContextMenu={(anchor) => onContextMenu(session, anchor)}
				/>
			))}
		</div>
	);
}
