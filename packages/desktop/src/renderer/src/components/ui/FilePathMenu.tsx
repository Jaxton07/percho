import { environmentEntityRef, LOCAL_ENVIRONMENT } from "@percho/shared";
import { getPi } from "../../api";
import { getExecutionApi } from "../../environment-api";
import { useT } from "../../i18n";
import { errText } from "../../lib/error-text";
import { remoteFilePath } from "../../lib/remote-file-path";
import { useToastsStore } from "../../stores/toasts";
import { CopyIcon, FileTextIcon, FolderIcon } from "../icons";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import type { MenuAnchor } from "./place-menu";

/**
 * 文件路径右键菜单（轮末文件行 / 变更侧栏文件卡共用）：
 * 打开文件（系统默认应用）/ 在访达中显示 / 复制路径。
 * 本机路径解析保留原生规则；远端只复制字面 POSIX 路径，不访问文件系统。
 * 路径不存在时三个动作各自 toast 报错（不做禁用态 —— 禁用态说不清原因）。
 */
export function FilePathMenu({
	target,
	cwd,
	anchor,
	onClose,
	fileUrl = false,
}: {
	/** 模型给出的原始路径文本（可能是相对路径） */
	target: string;
	fileUrl?: boolean;
	/** 会话工作目录（相对路径基准） */
	cwd: string | null;
	anchor: MenuAnchor;
	onClose: () => void;
}) {
	const t = useT();
	const environment = cwd ? environmentEntityRef(cwd).environment : LOCAL_ENVIRONMENT;

	const run = async (action: "open" | "reveal" | "copy") => {
		try {
			if (action === "copy") {
				// 复制的是解析后的绝对路径（原样复制相对路径对用户没用）
				const resolved =
					environment.kind === "ssh" && cwd
						? remoteFilePath(target, environmentEntityRef(cwd).id, fileUrl)
						: await getExecutionApi(environment).resolvePath({ target, cwd });
				await navigator.clipboard.writeText(resolved);
				// 剪贴板不可见，给一条 info 反馈（详情 = 绝对路径）
				useToastsStore.getState().push("info", "toast.pathCopied", resolved);
				return;
			}
			if (environment.kind === "ssh") {
				useToastsStore.getState().push("info", "toast.remotePathAction");
				return;
			}
			if (action === "open") await getPi().openPath({ target, cwd });
			else await getPi().revealPath({ target, cwd });
		} catch (error) {
			console.error("文件路径操作失败", { action, target, error });
			const key =
				action === "copy"
					? "toast.pathCopyFailed"
					: action === "reveal"
						? "toast.pathRevealFailed"
						: "toast.pathOpenFailed";
			useToastsStore.getState().push("error", key, errText(error));
		}
	};

	const items: ContextMenuItem[] = [
		{
			key: "open",
			label: t("pathMenu.open"),
			icon: <FileTextIcon size={13} />,
			onSelect: () => void run("open"),
		},
		{
			key: "reveal",
			label: t("pathMenu.reveal"),
			icon: <FolderIcon size={13} />,
			onSelect: () => void run("reveal"),
		},
		{
			key: "copy",
			label: t("pathMenu.copyPath"),
			icon: <CopyIcon size={13} />,
			onSelect: () => void run("copy"),
		},
	];

	return (
		<ContextMenu
			anchor={anchor}
			items={
				environment.kind === "ssh"
					? [
							...items.filter((item) => item.key === "copy"),
							{
								key: "remote-info",
								label: t("toast.remotePathAction"),
								onSelect: () => useToastsStore.getState().push("info", "toast.remotePathAction"),
							},
						]
					: items
			}
			onClose={onClose}
		/>
	);
}
