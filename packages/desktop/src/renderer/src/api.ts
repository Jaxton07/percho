import type { PiApi } from "@percho/shared";

declare global {
	interface Window {
		pi: PiApi;
	}
}

/** window.pi 类型化访问（未在 preload 注入时给出可读错误） */
export function getPi(): PiApi {
	if (!window.pi) {
		throw new Error("window.pi 未注入：preload 未加载或 contextBridge 失败");
	}
	return window.pi;
}
