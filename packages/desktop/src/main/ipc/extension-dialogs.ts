import type { PiBackend } from "@percho/backend";
import { EXTENSION_DIALOG_CHANNELS } from "@percho/shared";
import { registerInvokeHandlers } from "./invoke";

/** 扩展对话框域：renderer 应答（请求/结算/通知为 main→renderer 单向事件，在 index.ts 转发） */
export function registerExtensionDialogIpc(backend: PiBackend): void {
	registerInvokeHandlers(EXTENSION_DIALOG_CHANNELS, {
		respondExtensionDialog: ({ requestId, answer }) => backend.respondExtensionDialog(requestId, answer),
	});
}
