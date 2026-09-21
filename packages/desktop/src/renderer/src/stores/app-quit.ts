import { create } from "zustand";
import { getPi } from "../api";

/** 退出确认弹窗可见性（main 拦下关窗后置位；用户取消时由弹窗自己关掉） */
interface AppQuitStore {
	visible: boolean;
}

export const useAppQuitStore = create<AppQuitStore>()(() => ({ visible: false }));

let initialized = false;

/**
 * 接管退出确认（App 挂载时调用一次；模块级标志防 StrictMode 双执行）。
 * Windows 上 main 默认关窗即退，只有收到本 guard 才会拦下来让这里弹确认窗——
 * 所以「没挂载上」就等于退回原行为（直接退出），不会把窗口锁死。
 */
export function initAppQuit(): void {
	if (initialized) return;
	initialized = true;
	const pi = getPi();
	// 只有 Windows 的关窗语义是「退出」才需要拦下确认（macOS 红点=隐藏窗口，Linux 保持原样）
	if (pi.platform !== "win32") return;
	void pi.setQuitGuard({ enabled: true });
	// 重复触发（连点 ✕）只是把已为 true 的状态再置一次，不叠卡片
	pi.onQuitRequested(() => useAppQuitStore.setState({ visible: true }));
}
