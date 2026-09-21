import type { SessionMeta } from "@percho/shared";
import { useEffect, useRef } from "react";
import type { SidebarSession } from "../../lib/sidebar-groups";
import type { MenuAnchor } from "../ui/place-menu";
import { SessionRow } from "./SessionRow";

/** 会话列表的空间上限：8 个完整会话行（不露半行，避免把裁切误认成布局错误） */
export const SIDEBAR_SESSION_LIST_MAX_ROWS = 8;
/** 会话行高的布局常量（与 `SessionRow` 的固定行高 `h-[31px]` 配套；改行高要同时改两处） */
export const SIDEBAR_SESSION_ROW_HEIGHT = 31;

/** 把容器的滚动位置写成两个淡出属性（只读容器 + 写 data-*，不触发 React 渲染） */
function syncFadeAttrs(el: HTMLElement, scrollable: boolean) {
	if (!scrollable) {
		// 不溢出的列表没有"另一边"，边缘保持干净（也不留上一轮的旧属性）
		for (const key of ["fadeTop", "fadeBottom"] as const) delete el.dataset[key];
		return;
	}
	// 容差 1px：触控板/缩放下的分数 scrollTop 不该被当成"还能滚"
	el.dataset.fadeTop = el.scrollTop > 1 ? "true" : "false";
	el.dataset.fadeBottom = el.scrollHeight - el.clientHeight - el.scrollTop > 1 ? "true" : "false";
}

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
 * 边缘淡出（`.sidebar-session-list` 的 mask 规则在 globals.css）：上下两侧各自只在"那个方向还有内容"时淡出，
 * 让截断处是渐变而不是硬切线；淡出是 alpha 逆罩、不引入颜色，所以深浅色主题共用一套。
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
	const scrollRef = useRef<HTMLDivElement | null>(null);

	// 边缘淡出：只看当前滚动位置（纯读，不拦 wheel、不改 scrollTop）。
	// 两个属性由本组件独占——不写进 JSX，免得 React 重渲染把滚动中的状态冲回初值。
	// 1) 每次渲染后补算一次：行数变化会改 scrollHeight，而容器盒子可能不变（都溢出时恒 248px），
	//    光靠 ResizeObserver 盖不住这种变化；
	useEffect(() => {
		const el = scrollRef.current;
		if (el) syncFadeAttrs(el, scrollable);
	});
	// 2) 滚动时增量更新（passive，不进 React 状态）+ 容器尺寸变化时重算。
	useEffect(() => {
		const el = scrollRef.current;
		if (!el || !scrollable) return;
		const onScroll = () => syncFadeAttrs(el, true);
		el.addEventListener("scroll", onScroll, { passive: true });
		const observer = new ResizeObserver(onScroll);
		observer.observe(el);
		return () => {
			el.removeEventListener("scroll", onScroll);
			observer.disconnect();
		};
	}, [scrollable]);

	if (sessions.length === 0) {
		return <p className="py-1 pl-[30px] text-[12px] text-ink-faint">{emptyLabel}</p>;
	}
	return (
		<div
			ref={scrollRef}
			// 可测试性只读属性（验收脚本按它们定位并测量，纯属性，不影响视觉/交互）
			data-sidebar-session-list=""
			data-scrollable={scrollable ? "true" : "false"}
			className={`sidebar-session-list overflow-x-hidden overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${
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
