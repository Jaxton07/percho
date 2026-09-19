import type { SessionMeta } from "@percho/shared";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useT } from "../../i18n";
import { sessionTitle, useSessionStatus } from "../session/session-status";
import type { MenuAnchor } from "../ui/place-menu";

/** 行尾状态点：待审批琥珀（静态）/ 工作中墨色（呼吸，节拍与顶栏头像同一套）/ 完成未读绿；空闲无点。
 *  空字符串 = 不渲染（Tailwind 需要在源码里出现完整类名，不做字符串拼接） */
const DOT_CLASS: Record<string, string> = {
	attention: "bg-amber-500",
	working: "bg-ink sidebar-dot-working",
	done: "bg-green-500",
};

/**
 * 左侧栏会话行：无头像（项目归属已由所在分组表达）、单行文字 + 行尾状态点。
 * 点击 = 打开 / 切换会话（`openSession` 同一条路径）；右键菜单由调用方接线（阶段 3 复用 session-menu）。
 */
export function SessionRow({
	session,
	active,
	onSelect,
	onContextMenu,
}: {
	session: SessionMeta;
	active: boolean;
	onSelect: () => void;
	onContextMenu?: (anchor: MenuAnchor) => void;
}) {
	const t = useT();
	const status = useSessionStatus(session.sessionId);
	return (
		<button
			type="button"
			title={sessionTitle(session, t("projects.untitled"), t("projects.daily"))}
			className={`flex h-[27px] w-full items-center gap-2 rounded-[7px] pr-1.5 pl-[30px] text-left text-[12.5px] ${
				active ? "bg-bubble font-medium text-ink" : "text-ink-2 hover:bg-hover hover:text-ink"
			}`}
			onClick={onSelect}
			onContextMenu={
				onContextMenu
					? (e: ReactMouseEvent<HTMLButtonElement>) => {
							e.preventDefault();
							// 锚点 = 指针位置（与悬浮面板行一致的 "在指针处弹出" 语言），零尺寸矩形只用于避让
							onContextMenu({ left: e.clientX, top: e.clientY, width: 0, height: 0 });
						}
					: undefined
			}
		>
			<span className="min-w-0 flex-1 truncate">
				{sessionTitle(session, t("projects.untitled"), t("projects.daily"))}
			</span>
			{status !== "idle" && (
				<span
					className={`mr-0.5 h-1.5 w-1.5 shrink-0 rounded-full ${DOT_CLASS[status]}`}
					aria-hidden="true"
				/>
			)}
		</button>
	);
}
