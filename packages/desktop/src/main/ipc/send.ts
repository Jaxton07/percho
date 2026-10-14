import { BrowserWindow } from "electron";

/** 向 renderer 推事件（backend 事件转发 + 更新状态共用） */
export function sendToRenderer(channel: string, payload: unknown): void {
	const window = BrowserWindow.getAllWindows()[0];
	if (window && !window.isDestroyed()) {
		window.webContents.send(channel, payload);
	}
}
