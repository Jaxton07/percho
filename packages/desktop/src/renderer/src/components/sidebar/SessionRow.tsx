import type { SessionMeta } from "@percho/shared";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useT } from "../../i18n";
import { isDraftSessionId } from "../../stores/sessions";
import { PinIcon } from "../icons";
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
 * 点击 = 打开 / 切换会话（`openSession` 同一条路径）；右键菜单由调用方接线（复用 session-menu）。
 * v6 定稿：字号 13.5px / 行高 31px。
 * v8：置顶的行在**行首图标槽**里出一枚 12px 图钉（用户：置顶后没任何区分度）。槽位是
 * 固定 16×16（`px-1.5` + 16 + `gap-2` = 30px），所以带不带图钉，标题左缘恒在 30px（与项目名对齐）。
 */
export function SessionRow({
	session,
	active,
	pinned = false,
	onSelect,
	onContextMenu,
}: {
	session: SessionMeta;
	active: boolean;
	pinned?: boolean;
	onSelect: () => void;
	onContextMenu?: (anchor: MenuAnchor) => void;
}) {
	const t = useT();
	const status = useSessionStatus(session.sessionId);
	// draft 还没落盘、也没有名字：固定显示「新会话」（后来真的有名字了才回落到 sessionTitle）
	const title = isDraftSessionId(session.sessionId)
		? t("sidebar.newSession")
		: sessionTitle(session, t("projects.untitled"), t("projects.daily"));
	return (
		<button
			type="button"
			// 可测试性只读属性（spec §6：CDP 按 sessionId 定位行，而不是靠标题文本匹配；纯属性，不影响视觉/交互）
			data-session-id={session.sessionId}
			data-session-active={active ? "true" : "false"}
			title={title}
			className={`flex h-[31px] w-full items-center gap-2 rounded-[7px] px-1.5 text-left text-[13.5px] ${
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
			{/* 图标槽：置顶才放图钉，不带图钉时占位不空转（保证标题 x 恒定） */}
			<span className="grid h-4 w-4 shrink-0 place-items-center text-ink-faint" aria-hidden="true">
				{pinned && <PinIcon size={12} />}
			</span>
			<span className="min-w-0 flex-1 truncate">{title}</span>
			{status !== "idle" && (
				<span
					className={`mr-0.5 h-[7px] w-[7px] shrink-0 rounded-full ${DOT_CLASS[status]}`}
					aria-hidden="true"
				/>
			)}
		</button>
	);
}
