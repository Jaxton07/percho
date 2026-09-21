import { useEffect } from "react";
import { getPi } from "../../api";
import { useT } from "../../i18n";
import { useAppQuitStore } from "../../stores/app-quit";
import { ConfirmDialog } from "./ConfirmDialog";

/**
 * 退出前确认（Windows 点 ✕ 时 main 拦下 → 本弹窗；仅该平台会亮）。
 * 文案必须说清「退出后正在跑的任务会终止」——这是它存在的唯一理由；
 * 想临时收起窗口继续跑任务，用标题栏的 – 最小化。
 */
export function QuitConfirmDialog() {
	const t = useT();
	const visible = useAppQuitStore((s) => s.visible);

	// 上屏回执：main 侧在发出 quit-requested 后等这个回执（超时 = 渲染进程卡死，直接放行退出）。
	// 放在本节里（而非事件订阅处）是因为 useEffect 跑在提交之后——DOM 真存在了才算数
	useEffect(() => {
		if (visible) void getPi().quitDialogShown();
	}, [visible]);

	if (!visible) return null;
	return (
		<ConfirmDialog
			title={t("quitConfirm.title")}
			description={t("quitConfirm.desc")}
			confirmLabel={t("quitConfirm.confirm")}
			cancelLabel={t("common.cancel")}
			autoFocusConfirm
			onConfirm={() => {
				void getPi().confirmQuit();
			}}
			onCancel={() => useAppQuitStore.setState({ visible: false })}
		/>
	);
}
