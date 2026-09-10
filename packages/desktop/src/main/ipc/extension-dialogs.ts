import type { PiBackend } from "@percho/backend";
import type { ExtensionDialogRespond } from "@percho/shared";
import { IpcChannels } from "@percho/shared";
import { ipcMain } from "electron";

/** 扩展对话框域：renderer 应答（请求/结算/通知为 main→renderer 单向事件，在 index.ts 转发） */
export function registerExtensionDialogIpc(backend: PiBackend): void {
	ipcMain.handle(
		IpcChannels.ExtensionDialogRespond,
		(_e, requestId: string, answer: ExtensionDialogRespond) =>
			backend.respondExtensionDialog(requestId, answer),
	);
}
