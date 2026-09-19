import { useState } from "react";
import { useT } from "../../i18n";
import { ChevronDownIcon, CoffeeIcon, FolderIcon, MoreIcon, PinIcon } from "../icons";
import { ContextMenu } from "../ui/ContextMenu";
import type { MenuAnchor } from "../ui/place-menu";
import { projectMenuItems } from "./ProjectMenu";

/**
 * 分组行（日常 / 每个项目共用）：折叠态 = 空间图标（日常咖啡 / 项目文件夹），展开态 = chevron ⌄。
 * hover 出行底高亮 + 右侧 «⋯» 菜单锚点（命中区 20px 见 globals.css 的 .sidebar-more）。
 * «⋯» 是行的**兄弟节点**（绝对定位浮在行右端）而不是嵌套 button——避免 button 套 button。
 */
export function ProjectRow({
	label,
	kind,
	expanded,
	pinned = false,
	onToggle,
	onTogglePin,
}: {
	label: string;
	kind: "daily" | "project";
	expanded: boolean;
	pinned?: boolean;
	onToggle: () => void;
	/** 给了才渲染 «⋯»（阶段 2 只有项目行有：置顶；日常没有可做的事就不给死按钮） */
	onTogglePin?: () => void;
}) {
	const t = useT();
	const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
	const togglePin = onTogglePin;
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
				className={`flex h-[30px] w-full items-center gap-2 rounded-[7px] px-1.5 text-[13px] text-ink-2 group-hover/row:bg-hover group-hover/row:text-ink ${
					expanded ? "text-ink" : ""
				}`}
				onClick={onToggle}
			>
				<span className="flex shrink-0 items-center" aria-hidden="true">
					{icon}
				</span>
				<span className="min-w-0 flex-1 truncate text-left font-medium">{label}</span>
				{pinned && (
					<span className="flex shrink-0 text-ink-faint" aria-hidden="true">
						<PinIcon size={11} />
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
					items={projectMenuItems(t, { pinned, onTogglePin: togglePin })}
					onClose={() => setAnchor(null)}
				/>
			)}
		</div>
	);
}
