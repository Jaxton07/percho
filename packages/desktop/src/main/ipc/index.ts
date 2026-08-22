import type { PiBackend } from "@percho/backend";
import type { PermissionRequest, TrustRequest } from "@percho/shared";
import { IpcChannels } from "@percho/shared";
import { BrowserWindow } from "electron";
import type { LanObserverHandle } from "../lan";
import type { UiPluginManager } from "../ui-plugins/manager";
import { onUpdateState } from "../updater";
import { registerAppIpc } from "./app";
import { registerLanIpc } from "./lan";
import { registerPackagesIpc } from "./packages";
import { registerSessionsIpc } from "./sessions";
import { registerSettingsIpc } from "./settings";
import { registerUiPluginsIpc } from "./ui-plugins";

/** 向 renderer 推事件（backend 事件转发 + 更新状态共用） */
export function sendToRenderer(channel: string, payload: unknown): void {
	const window = BrowserWindow.getAllWindows()[0];
	if (window && !window.isDestroyed()) {
		window.webContents.send(channel, payload);
	}
}

/**
 * IPC 注册组合入口：按域拆在 ./sessions ./settings ./packages ./app ./ui-plugins 五个文件，
 * 这里只做拼装 + backend/updater 事件转发到 renderer。
 */
export function registerIpc(
	backend: PiBackend,
	uiPluginsManager: UiPluginManager,
	lan: LanObserverHandle,
): void {
	registerSessionsIpc(backend);
	registerSettingsIpc(backend);
	registerPackagesIpc(backend);
	registerAppIpc(backend);
	registerUiPluginsIpc(uiPluginsManager);
	registerLanIpc(lan);
	// 热重载 watcher：插件源码变更 → 重建 → 推 changed 事件（renderer 经 loader reloadPlugin 热替换）
	uiPluginsManager.startWatcher((name) => {
		sendToRenderer(IpcChannels.UiPluginsEvent, { kind: "changed", name });
	});

	backend.onEvent((sessionId, event) => {
		sendToRenderer(IpcChannels.Event, { sessionId, event });
	});
	backend.onPermissionRequest((req: PermissionRequest) => {
		sendToRenderer(IpcChannels.PermissionRequest, req);
	});
	backend.onTrustRequest((req: TrustRequest) => {
		sendToRenderer(IpcChannels.TrustRequest, req);
	});
	backend.onLoginEvent((payload) => {
		sendToRenderer(IpcChannels.SettingsLoginEvent, payload);
	});
	onUpdateState((state) => {
		sendToRenderer(IpcChannels.UpdateEvent, state);
	});
}
