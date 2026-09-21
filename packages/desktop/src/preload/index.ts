import {
	CHANNEL_TABLE,
	type ExtensionDialogRequest,
	type ExtensionDialogResolved,
	type ExtensionEditorTextEvent,
	type ExtensionNotifyEvent,
	type InvokeApi,
	IpcChannels,
	type LoginEventPayload,
	type PermissionRequest,
	type PermissionResolved,
	type PiApi,
	type SessionEventEnvelope,
	type TrustRequest,
	type UiPluginsEventPayload,
	type UpdateState,
} from "@percho/shared";
import { contextBridge, ipcRenderer } from "electron";

/** 事件订阅包装：ipcRenderer.on + 返回退订函数（removeListener），payload 透传 */
function makeSubscription<T>(channel: string): (cb: (payload: T) => void) => () => void {
	return (cb) => {
		const listener = (_event: unknown, payload: T) => cb(payload);
		ipcRenderer.on(channel, listener);
		return () => ipcRenderer.removeListener(channel, listener);
	};
}

/** 表化 invoke 通道：循环注册（args 单对象透传；通道定义 = shared/ipc-channels.ts 单一事实源） */
const invokeApi = Object.fromEntries(
	Object.entries(CHANNEL_TABLE).map(([key, def]) => [
		key,
		(args: unknown) => ipcRenderer.invoke(def.channel, args),
	]),
) as InvokeApi<typeof CHANNEL_TABLE>;

const api: PiApi = {
	platform: process.platform,
	...invokeApi,
	onProviderLoginEvent: makeSubscription<LoginEventPayload>(IpcChannels.SettingsLoginEvent),
	onUiPluginsEvent: makeSubscription<UiPluginsEventPayload>(IpcChannels.UiPluginsEvent),
	onQuitRequested: makeSubscription<void>(IpcChannels.QuitRequested),
	onUpdateEvent: makeSubscription<UpdateState>(IpcChannels.UpdateEvent),
	onEvent: makeSubscription<SessionEventEnvelope>(IpcChannels.Event),
	onPermissionRequest: makeSubscription<PermissionRequest>(IpcChannels.PermissionRequest),
	onPermissionResolved: makeSubscription<PermissionResolved>(IpcChannels.PermissionResolved),
	onTrustRequest: makeSubscription<TrustRequest>(IpcChannels.TrustRequest),
	onExtensionDialogRequest: makeSubscription<ExtensionDialogRequest>(IpcChannels.ExtensionDialogRequest),
	onExtensionDialogResolved: makeSubscription<ExtensionDialogResolved>(IpcChannels.ExtensionDialogResolved),
	onExtensionNotify: makeSubscription<ExtensionNotifyEvent>(IpcChannels.ExtensionNotify),
	onExtensionEditorText: makeSubscription<ExtensionEditorTextEvent>(IpcChannels.ExtensionEditorText),
};

contextBridge.exposeInMainWorld("pi", api);
