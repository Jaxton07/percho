import { create } from "zustand";
import type { MessageKey } from "../i18n";

/** 全局 Toast（顶栏右侧浮动）：非阻塞、自动消失——只用于「需要人知道但不用当场处理」的通知 */

export type ToastSeverity = "error" | "warning" | "info";

export interface AppToast {
	id: string;
	severity: ToastSeverity;
	/** 应用内 toast 的 i18n key（与 titleText 二选一） */
	titleKey?: MessageKey;
	/** 扩展 notify 的原文标题（不走 i18n，titleKey 上的扩展消息） */
	titleText?: string;
	/** 应用内：扩展信息；扩展 notify：来源副标题（扩展名，可能缺省） */
	detail?: string;
	timestamp: number;
}

interface ToastsState {
	toasts: AppToast[];
	/** 扩展 notify 超出可见栈上限被折叠的条数（扩展卡退场时递减） */
	overflowCount: number;
	push: (severity: ToastSeverity, titleKey: MessageKey, detail?: string) => void;
	/** 扩展 notify 入口（issue #45）：同源同文 8s 去重 + 可见栈上限 3 溢出折叠（D6） */
	pushExtension: (severity: ToastSeverity, message: string, source?: string) => void;
	dismiss: (id: string) => void;
	/** 自动消失出口（push 的定时器调用；应用/扩展 toast 通用） */
	removeToast: (id: string) => void;
}

let nextToastId = 0;
const TOAST_TTL_MS = 4500;
/** 同一扩展同一文本的合并窗口 */
const DEDUP_WINDOW_MS = 8000;
/** 扩展 notify 可见栈上限（超出折叠一行注脚） */
const EXT_VISIBLE_CAP = 3;
/** 去重表硬上限（防失控扩展撑爆内存；超限先清过期再整表清空） */
const DEDUP_MAX_ENTRIES = 256;

const recentExtensionToasts = new Map<string, number>();

export const useToastsStore = create<ToastsState>()((set, get) => ({
	toasts: [],
	overflowCount: 0,
	push: (severity, titleKey, detail) => {
		const toast: AppToast = {
			id: `toast${nextToastId++}`,
			severity,
			titleKey,
			detail,
			timestamp: Date.now(),
		};
		set((state) => ({ toasts: [...state.toasts.slice(-3), toast] }));
		setTimeout(() => get().removeToast(toast.id), TOAST_TTL_MS);
	},
	pushExtension: (severity, message, source) => {
		const now = Date.now();
		const dedupKey = `${source ?? ""}|${message}`;
		const last = recentExtensionToasts.get(dedupKey);
		if (last !== undefined && now - last < DEDUP_WINDOW_MS) return;
		recentExtensionToasts.set(dedupKey, now);
		if (recentExtensionToasts.size > DEDUP_MAX_ENTRIES) {
			for (const [key, at] of recentExtensionToasts) {
				if (now - at >= DEDUP_WINDOW_MS) recentExtensionToasts.delete(key);
			}
			if (recentExtensionToasts.size > DEDUP_MAX_ENTRIES) recentExtensionToasts.clear();
		}
		const toast: AppToast = {
			id: `toast${nextToastId++}`,
			severity,
			titleText: message,
			...(source ? { detail: source } : {}),
			timestamp: now,
		};
		set((state) => {
			const visible = state.toasts.filter((t) => t.titleText !== undefined);
			let toasts = state.toasts;
			let overflowCount = state.overflowCount;
			// 溢出折叠：最老的扩展卡退出可见栈，计数 +1（它退场时计数 -1，见 removeToast）
			const oldest = visible[0];
			if (visible.length >= EXT_VISIBLE_CAP && oldest) {
				toasts = toasts.filter((t) => t.id !== oldest.id);
				overflowCount += 1;
			}
			return { toasts: [...toasts, toast], overflowCount };
		});
		setTimeout(() => get().removeToast(toast.id), TOAST_TTL_MS);
	},
	dismiss: (id) => get().removeToast(id),
	removeToast: (id) => {
		set((state) => {
			const toast = state.toasts.find((t) => t.id === id);
			if (!toast) return state;
			// 折叠计数跟随扩展卡退场递减（应用 toast 不影响）
			const overflowCount =
				toast.titleText !== undefined ? Math.max(0, state.overflowCount - 1) : state.overflowCount;
			return { toasts: state.toasts.filter((t) => t.id !== id), overflowCount };
		});
	},
}));

/** 便捷入口（store 外调用：主进程回调/持久化 catch 等） */
export const pushToast = (severity: ToastSeverity, titleKey: MessageKey, detail?: string) =>
	useToastsStore.getState().push(severity, titleKey, detail);

/** 扩展 notify 便捷入口（事件桥用） */
export const pushExtensionToast = (severity: ToastSeverity, message: string, source?: string) =>
	useToastsStore.getState().pushExtension(severity, message, source);
