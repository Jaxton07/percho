import type { PiBackend } from "@percho/backend";
import { IpcChannels } from "@percho/shared";
import { BrowserWindow } from "electron";
import type { LanObserverHandle } from "../lan";
import type { UiPluginManager } from "../ui-plugins/manager";
import { onUpdateState } from "../updater";
import { registerAppIpc } from "./app";
import { registerExtensionDialogIpc } from "./extension-dialogs";
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

/** 订阅 backend/updater 事件并透传转发 renderer（payload 不变形的转发统一走这里） */
function forward<T>(subscribe: (handler: (payload: T) => void) => void, channel: string): void {
	subscribe((payload) => sendToRenderer(channel, payload));
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
	registerExtensionDialogIpc(backend);
	registerUiPluginsIpc(uiPluginsManager);
	registerLanIpc(lan);
	// 热重载 watcher：插件源码变更 → 重建 → 推 changed 事件（renderer 经 loader reloadPlugin 热替换）
	uiPluginsManager.startWatcher((name) => {
		sendToRenderer(IpcChannels.UiPluginsEvent, { kind: "changed", name });
	});

	// onEvent 载荷是 (sessionId, event) → 信封封装，不透明传，单行保留
	backend.onEvent((sessionId, event) => {
		sendToRenderer(IpcChannels.Event, { sessionId, event });
	});
	forward(backend.onPermissionRequest.bind(backend), IpcChannels.PermissionRequest);
	// 权限裁决也回投渲染端：LAN 远程应答 / 其他来源应答时桌面卡片要同步撤掉
	forward(backend.onPermissionResolved.bind(backend), IpcChannels.PermissionResolved);
	forward(backend.onTrustRequest.bind(backend), IpcChannels.TrustRequest);
	// 扩展对话框四事件：请求/结算/notify/草稿预填（issue #45）
	forward(backend.onExtensionDialogRequest.bind(backend), IpcChannels.ExtensionDialogRequest);
	forward(backend.onExtensionDialogResolved.bind(backend), IpcChannels.ExtensionDialogResolved);
	forward(backend.onExtensionNotify.bind(backend), IpcChannels.ExtensionNotify);
	forward(backend.onExtensionEditorText.bind(backend), IpcChannels.ExtensionEditorText);
	forward(backend.onLoginEvent.bind(backend), IpcChannels.SettingsLoginEvent);
	forward(onUpdateState, IpcChannels.UpdateEvent);
}
