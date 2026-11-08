import type { SessionMeta } from "@percho/shared";
import { useT } from "../../i18n";
import type { SidebarSession } from "../../lib/sidebar-groups";
import { useListShift } from "../../lib/use-list-shift";
import type { MenuAnchor } from "../ui/place-menu";
import { SessionRow } from "./SessionRow";

/**
 * 分组的会话列表（日常与每个项目共用）：**只画调用方裁好的那一段**（`sessions` 已经是前 N 条）。
 *
 * 这里**不再有任何自己的滚动**（v13 统一滚动）：没有限高、没有 `overflow-y-auto`、没有
 * `overscroll-y-contain`、没有边缘淡出——整条左栏只有 Sidebar 的那一个外层滚动容器，
 * 于是滚轮落在会话行、项目标题、按钮还是空白处，滚的都是同一个主体（见 spec: sidebar-unified-scroll）。
 * 想少画几行就点列表末尾的「显示更多」，不是滚它。
 *
 * 纯 props 驱动：不读 store、不排序、不管展开态与菜单状态（那些属于 `SidebarGroup`）。
 */
export function SidebarSessionList({
	sessions,
	activeSessionId,
	emptyLabel,
	showMoreLabel,
	hasMore,
	onShowMore,
	onSelect,
	onContextMenu,
	paging,
}: {
	/** 当前应显示的会话（已由调用方按 `6 + 16 × 点击数` 裁剪，顺序不变） */
	sessions: readonly SidebarSession[];
	activeSessionId: string | null;
	emptyLabel: string;
	showMoreLabel: string;
	/** 还有没显示的会话 → 末尾出「显示更多」 */
	hasMore: boolean;
	onShowMore: () => void;
	onSelect: (session: SessionMeta) => void;
	onContextMenu: (session: SessionMeta, anchor: MenuAnchor) => void;
	paging?: {
		loading: boolean;
		error?: string;
		partial: boolean;
		offline?: boolean;
		onConnect?: () => void;
		onRetry: () => void;
	};
}) {
	const t = useT();
	const listRef = useListShift({ collapse: true });
	const status = paging?.offline
		? "offline"
		: paging?.error
			? "error"
			: paging?.loading
				? "loading"
				: paging?.partial
					? "partial"
					: undefined;
	if (sessions.length === 0 && !status) {
		return <p className="py-1 pl-[30px] text-ui-12 text-ink-faint">{emptyLabel}</p>;
	}
	return (
		<div ref={listRef} className="relative">
			{/* 可测试性只读属性（验收脚本按它定位列表并断言「这里没有自己的滚动」；纯属性，不影响视觉） */}
			<div data-sidebar-session-list="" aria-busy={status === "loading"}>
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
			{/* 状态互斥，放在已有会话之后，连接/刷新状态变化不挤动缓存行。 */}
			{status === "offline" && (
				<div role="status" className="flex items-center gap-2 py-1 pl-[30px] text-ui-12 text-ink-faint">
					<span>{t("sidebar.catalogOffline")}</span>
					{paging?.onConnect && (
						<button type="button" className="hover:text-ink-2" onClick={paging.onConnect}>
							{t("sidebar.catalogConnect")}
						</button>
					)}
				</div>
			)}
			{status === "error" && (
				<button
					type="button"
					className="py-1 pl-[30px] text-ui-12 text-ink-faint hover:text-ink-2"
					onClick={paging?.onRetry}
				>
					{t("sidebar.catalogRetry")}
				</button>
			)}
			{status === "loading" && sessions.length === 0 && (
				<p role="status" className="py-1 pl-[30px] text-ui-12 text-ink-faint">
					{t("sidebar.catalogLoading")}
				</p>
			)}
			{status === "partial" && (
				<button
					type="button"
					className="py-1 pl-[30px] text-ui-12 text-ink-faint hover:text-ink-2"
					onClick={paging?.onRetry}
				>
					{t("sidebar.catalogPartial")}
				</button>
			)}
			{/* 幽灵文字按钮（左侧缩进与会话标题同为 30px），行高沿用 31px 保持纵向节奏；
			    点击只增行、不动视口位置。放在列表容器**外面**：列表容器里只有会话行 */}
			{hasMore && (
				<button
					type="button"
					data-sidebar-show-more=""
					data-shift-key="footer:more"
					data-shift-layout-only=""
					disabled={paging?.offline || paging?.loading}
					className="flex h-[31px] w-full items-center rounded-[7px] pl-[30px] text-left text-ui-12 text-ink-faint transition-colors hover:bg-hover hover:text-ink-2 focus-visible:bg-hover focus-visible:text-ink-2"
					onClick={onShowMore}
				>
					{showMoreLabel}
				</button>
			)}
		</div>
	);
}
