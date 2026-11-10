import { environmentEntityRef } from "@percho/shared";
import { getPi } from "../../api";
import type { Translate } from "../../i18n";
import { errText } from "../../lib/error-text";
import { useToastsStore } from "../../stores/toasts";
import { FolderOpenIcon, PinIcon, TrashIcon } from "../icons";
import type { ContextMenuItem } from "../ui/ContextMenu";

/** 项目 «⋯» 菜单项；本机项目可在系统文件管理器中打开，远程目录不交给本机 shell。 */
export function projectMenuItems(
	t: Translate,
	ops: { cwd?: string; pinned: boolean; onTogglePin: () => void; onRemove?: () => void },
): ContextMenuItem[] {
	const cwd = ops.cwd;
	return [
		{
			key: "pin",
			label: ops.pinned ? t("sidebar.unpin") : t("sidebar.pin"),
			icon: <PinIcon size={13} />,
			onSelect: ops.onTogglePin,
		},
		...(cwd && environmentEntityRef(cwd).environment.kind === "local"
			? [
					{
						key: "open-directory",
						label: t(
							getPi().platform === "darwin"
								? "pathMenu.openFinder"
								: getPi().platform === "win32"
									? "pathMenu.openExplorer"
									: "pathMenu.openFolder",
						),
						icon: <FolderOpenIcon size={13} />,
						onSelect: async () => {
							try {
								await getPi().openPath({ target: ".", cwd });
							} catch (error) {
								useToastsStore.getState().push("error", "toast.directoryOpenFailed", errText(error));
							}
						},
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
