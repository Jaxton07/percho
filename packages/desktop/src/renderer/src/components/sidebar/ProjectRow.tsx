import { useState } from "react";
import { useT } from "../../i18n";
import { CoffeeIcon, ExpandArrowIcon, FolderIcon, FolderOpenIcon, MoreIcon, PinIcon } from "../icons";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { ContextMenu } from "../ui/ContextMenu";
import type { MenuAnchor } from "../ui/place-menu";
import { projectMenuItems } from "./ProjectMenu";

/**
 * 分组行（日常 / 每个项目共用）。
 * **图标表达状态（v7）**：项目 = 折叠 `FolderIcon` ↔ 展开 `FolderOpenIcon`（同源同风格，不再变 chevron → 不跳变）；
 * 日常 = 恒 `CoffeeIcon`（状态不由图标表达），行末 hover 出一个 `ExpandArrowIcon` 当折叠提示。
 * 行末槽位二选一：项目行只有 «⋯»（菜单）、日常行只有展开箭头（纯装饰，`pointer-events-none` 让点击落到行按钮）。
 *
 * «⋯» 是行的**兄弟节点**（绝对定位浮在行右端）而不是嵌套 button——避免 button 套 button；
 * 菜单锚点用**指针点**（同 SessionRow 右键菜单），不然 placeMenu 会把按钮高度再算一遍、菜单掉到行下方左侧。
 * 「移除项目」走二次确认（ConfirmDialog，z-60 压过菜单）：菜单项 onSelect 先执行（开弹窗）、ContextMenu
 * 随后自己关闭，所以视觉上是「菜单消失 → 弹窗已在」；文案里的会话条数用 totalSessions（不受搜索影响）。
 *
 * 图标槽：folder/folder-open/咖啡/图钉/箭头都装在 **16×16 固定容器**里居中
 * （v6 定稿）：图标自身宽度不同曾把标题顶得左右跳，现在文字 x 恒定；会话行缩进 6+16+8=30 也不变。
 * 字号：项目名/日常名 14px/500（行高 34），见画板 E 的 v6 表。
 */
export function ProjectRow({
	label,
	kind,
	expanded,
	pinned = false,
	totalSessions = 0,
	onToggle,
	onTogglePin,
	onRemove,
}: {
	label: string;
	kind: "daily" | "project";
	expanded: boolean;
	pinned?: boolean;
	/** 会话总数（只有项目组传）：移除确认文案里的真实条数 */
	totalSessions?: number;
	onToggle: () => void;
	/** 给了才渲染 «⋯»（阶段 2 只有项目行有：置顶；日常没有可做的事就不给死按钮） */
	onTogglePin?: () => void;
	/** 给了才在 «⋯» 里出「移除项目」（日常不可移除） */
	onRemove?: () => void;
}) {
	const t = useT();
	const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
	const [confirming, setConfirming] = useState(false);
	const togglePin = onTogglePin;
	const remove = onRemove;
	const icon =
		kind === "daily" ? (
			<CoffeeIcon size={16} />
		) : expanded ? (
			<FolderOpenIcon size={16} />
		) : (
			<FolderIcon size={16} />
		);
	return (
		<div className="group/row relative">
			<button
				type="button"
				aria-expanded={expanded}
				title={label}
				className={`flex h-[34px] w-full items-center gap-2 rounded-[7px] px-1.5 text-[14px] text-ink-2 group-hover/row:bg-hover group-hover/row:text-ink ${
					expanded ? "text-ink" : ""
				}`}
				onClick={onToggle}
			>
				<span className="grid h-4 w-4 shrink-0 place-items-center" aria-hidden="true">
					{icon}
				</span>
				<span className="min-w-0 flex-1 truncate text-left font-medium">{label}</span>
				{pinned && (
					<span className="grid h-4 w-4 shrink-0 place-items-center text-ink-faint" aria-hidden="true">
						<PinIcon size={12} />
					</span>
				)}
			</button>
			{kind === "daily" && (
				// 纯装饰（点击穿透到行按钮）：折叠提示只在 hover 时现，项目行则用 folder-open 表达状态
				<span
					aria-hidden="true"
					className="pointer-events-none absolute top-1/2 right-1 grid h-5 w-5 -translate-y-1/2 place-items-center text-ink-faint opacity-0 transition-[opacity,transform,color] group-hover/row:opacity-100 group-hover/row:text-ink-2"
				>
					<ExpandArrowIcon size={12} className={`transition-transform ${expanded ? "rotate-90" : ""}`} />
				</span>
			)}
			{togglePin && (
				<button
					type="button"
					aria-label={t("sidebar.more")}
					className="absolute top-1/2 right-1 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-md text-ink-dim opacity-0 transition-opacity group-hover/row:opacity-100 group-hover/row:pointer-events-auto hover:bg-hover hover:text-ink focus-visible:pointer-events-auto focus-visible:opacity-100 pointer-events-none"
					onClick={(e) => {
						// 锚在**指针点**：菜单落在点击处右下方（placeMenu 会在贴右缘时自动左翻）
						setAnchor({ left: e.clientX, top: e.clientY, width: 0, height: 0 });
					}}
				>
					<MoreIcon size={14} />
				</button>
			)}
			{anchor && togglePin && (
				<ContextMenu
					anchor={anchor}
					items={projectMenuItems(t, {
						pinned,
						onTogglePin: togglePin,
						onRemove: remove ? () => setConfirming(true) : undefined,
					})}
					onClose={() => setAnchor(null)}
				/>
			)}
			{confirming && remove && (
				<ConfirmDialog
					danger
					title={t("sidebar.removeProjectTitle", { name: label })}
					description={
						totalSessions > 0
							? t("sidebar.removeProjectDesc", { count: totalSessions })
							: t("sidebar.removeProjectDescEmpty")
					}
					confirmLabel={t("sidebar.removeProject")}
					cancelLabel={t("common.cancel")}
					onConfirm={() => {
						setConfirming(false);
						remove();
					}}
					onCancel={() => setConfirming(false)}
				/>
			)}
		</div>
	);
}
