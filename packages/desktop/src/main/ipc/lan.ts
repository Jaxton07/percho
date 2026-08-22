import { IpcChannels } from "@percho/shared";
import { ipcMain } from "electron";
import type { LanObserverHandle } from "../lan";

/** LAN Observer IPC：仅控制本机服务开关，远端 HTTP 服务本身无写端点。 */
export function registerLanIpc(lan: LanObserverHandle): void {
	ipcMain.handle(IpcChannels.LanGetStatus, () => lan.getStatus());
	ipcMain.handle(IpcChannels.LanSetEnabled, (_event, enabled: unknown) => {
		if (typeof enabled !== "boolean") return;
		return lan.setEnabled(enabled);
	});
}
