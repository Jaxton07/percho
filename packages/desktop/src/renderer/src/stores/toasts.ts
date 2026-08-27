import { create } from "zustand";
import type { MessageKey } from "../i18n";

/** 全局 Toast（顶栏右侧浮动）：非阻塞、自动消失——只用于「需要人知道但不用当场处理」的通知 */

export type ToastSeverity = "error" | "warning" | "info";

export interface AppToast {
	id: string;
	severity: ToastSeverity;
	titleKey: MessageKey;
	/** 扩展信息（原始错误文本，最多一行） */
	detail?: string;
	timestamp: number;
}

interface ToastsState {
	toasts: AppToast[];
	push: (severity: ToastSeverity, titleKey: MessageKey, detail?: string) => void;
	dismiss: (id: string) => void;
}

let nextToastId = 0;

export const useToastsStore = create<ToastsState>()((set) => ({
	toasts: [],
	push: (severity, titleKey, detail) => {
		const toast: AppToast = {
			id: `toast${nextToastId++}`,
			severity,
			titleKey,
			detail,
			timestamp: Date.now(),
		};
		set((state) => ({ toasts: [...state.toasts.slice(-3), toast] }));
		// 自动消失（4.5s；新 toast 挤掉最老的，栈上限 4）
		setTimeout(() => {
			set((state) => ({ toasts: state.toasts.filter((t) => t.id !== toast.id) }));
		}, 4500);
	},
	dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
}));

/** 便捷入口（store 外调用：主进程回调/持久化 catch 等） */
export const pushToast = (severity: ToastSeverity, titleKey: MessageKey, detail?: string) =>
	useToastsStore.getState().push(severity, titleKey, detail);
