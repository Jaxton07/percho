import type { Translate } from "../../i18n";
import { FolderIcon, PinIcon, TrashIcon } from "../icons";
import type { ContextMenuItem } from "../ui/ContextMenu";

/**
 * 项目 «⋯» 菜单项（左栏项目行 / 日常行的右键或 ⋯ 共用）。纯 builder，不持有状态；
 *「置顶」恒有；`onEditFolders` 传了才有「编辑项目」（额外文件夹），`onRemove` 传了才有「移除项目」。
 */
export function projectMenuItems(
	t: Translate,
	ops: { pinned: boolean; onTogglePin: () => void; onEditFolders?: () => void; onRemove?: () => void },
): ContextMenuItem[] {
	return [
		{
			key: "pin",
			label: ops.pinned ? t("sidebar.unpin") : t("sidebar.pin"),
			icon: <PinIcon size={13} />,
			onSelect: ops.onTogglePin,
		},
		...(ops.onEditFolders
			? [
					{
						key: "editFolders",
						label: t("sidebar.editProject"),
						icon: <FolderIcon size={13} />,
						onSelect: ops.onEditFolders,
					} satisfies ContextMenuItem,
				]
			: []),
		...(ops.onRemove
			? [
					{
						key: "remove",
						label: t("sidebar.removeProject"),
						icon: <TrashIcon size={13} />,
						separatorBefore: true,
						danger: true,
						onSelect: ops.onRemove,
					} satisfies ContextMenuItem,
				]
			: []),
	];
}
