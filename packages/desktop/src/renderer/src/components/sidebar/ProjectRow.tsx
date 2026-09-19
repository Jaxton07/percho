import { useState } from "react";
import { useT } from "../../i18n";
import { ChevronDownIcon, CoffeeIcon, FolderIcon, MoreIcon, PinIcon } from "../icons";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { ContextMenu } from "../ui/ContextMenu";
import type { MenuAnchor } from "../ui/place-menu";
import { projectMenuItems } from "./ProjectMenu";

/**
 * 分组行（日常 / 每个项目共用）：折叠态 = 空间图标（日常咖啡 / 项目文件夹），展开态 = chevron ⌄。
 * hover 出行底高亮 + 右侧 «⋯» 菜单锚点（命中区 20px 见 globals.css 的 .sidebar-more）。
 * «⋯» 是行的**兄弟节点**（绝对定位浮在行右端）而不是嵌套 button——避免 button 套 button。
 * 「移除项目」走二次确认（ConfirmDialog，z-60 压过菜单）：菜单项 onSelect 先执行（开弹窗）、ContextMenu
 * 随后自己关闭，所以视觉上是「菜单消失 → 弹窗已在」；文案里的会话条数用 totalSessions（不受搜索影响）。
 *
 * 图标槽：folder(16) / chevron(14) / 咖啡(16) / 图钉都装在 **16×16 固定容器**里居中
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
	const icon = expanded ? (
		<ChevronDownIcon size={14} className="text-ink-dim" />
	) : kind === "daily" ? (
		<CoffeeIcon size={16} />
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
			{togglePin && (
				<button
					type="button"
					aria-label={t("sidebar.more")}
					className="absolute top-1/2 right-1 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-md text-ink-dim opacity-0 transition-opacity group-hover/row:opacity-100 group-hover/row:pointer-events-auto hover:bg-hover hover:text-ink focus-visible:pointer-events-auto focus-visible:opacity-100 pointer-events-none"
					onClick={(e) => {
						const rect = e.currentTarget.getBoundingClientRect();
						setAnchor({ left: rect.right - 176, top: rect.bottom, width: 176, height: rect.height });
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
