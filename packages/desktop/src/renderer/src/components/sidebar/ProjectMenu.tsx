import type { Translate } from "../../i18n";
import { FolderIcon, GearIcon, PinIcon, TrashIcon } from "../icons";
import type { ContextMenuItem } from "../ui/ContextMenu";

/**
 * 项目 «⋯» 菜单项（左栏项目行 / 日常行的右键或 ⋯ 共用）。纯 builder，不持有状态；
 *「置顶」恒有；`onEditFolders` 传了才有「编辑」（额外文件夹），`onReveal` 传了才有「在 Finder 中显示」，
 * `onRemove` 传了才有「移除项目」（危险色）。分隔线分组：置顶/编辑 · 显示 · 移除。
 */
export function projectMenuItems(
	t: Translate,
	ops: {
		pinned: boolean;
		onTogglePin: () => void;
		onEditFolders?: () => void;
		onReveal?: () => void;
		/** 由调用方按平台算好（`revealLabelKey`），不给就不出这一项 */
		revealLabel?: string;
		onRemove?: () => void;
	},
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
						icon: <GearIcon size={13} />,
						onSelect: ops.onEditFolders,
					} satisfies ContextMenuItem,
				]
			: []),
		...(ops.onReveal && ops.revealLabel
			? [
					{
						key: "reveal",
						label: ops.revealLabel,
						icon: <FolderIcon size={13} />,
						separatorBefore: true,
						onSelect: ops.onReveal,
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
