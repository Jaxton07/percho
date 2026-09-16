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
	installPackage: (name) => ipcRenderer.invoke(IpcChannels.PackagesInstall, name),
	removePackage: (source, scope) => ipcRenderer.invoke(IpcChannels.PackagesRemove, source, scope),
	listConfiguredPackages: () => ipcRenderer.invoke(IpcChannels.PackagesListConfigured),
	onProviderLoginEvent: makeSubscription<LoginEventPayload>(IpcChannels.SettingsLoginEvent),
	lanGetStatus: () => ipcRenderer.invoke(IpcChannels.LanGetStatus),
	lanSetEnabled: (enabled) => ipcRenderer.invoke(IpcChannels.LanSetEnabled, enabled),
	lanSetRemoteControl: (enabled) => ipcRenderer.invoke(IpcChannels.LanSetRemoteControl, enabled),
	pickDirectory: () => ipcRenderer.invoke(IpcChannels.ProjectPickDirectory),
	getGitBranch: (cwd) => ipcRenderer.invoke(IpcChannels.ProjectGetGitBranch, cwd),
	listGitBranches: (cwd) => ipcRenderer.invoke(IpcChannels.ProjectListGitBranches, cwd),
	checkoutBranch: (cwd, branch) => ipcRenderer.invoke(IpcChannels.ProjectCheckoutBranch, cwd, branch),
	openExternal: (url) => ipcRenderer.invoke(IpcChannels.AppOpenExternal, url),
	getAppInfo: () => ipcRenderer.invoke(IpcChannels.AppGetInfo),
	getDailyDir: () => ipcRenderer.invoke(IpcChannels.AppGetDailyDir),
	loadTabs: () => ipcRenderer.invoke(IpcChannels.TabsLoad),
	saveTabs: (tabs) => ipcRenderer.invoke(IpcChannels.TabsSave, tabs),
	loadUiState: () => ipcRenderer.invoke(IpcChannels.UiStateLoad),
	saveUiState: (state) => ipcRenderer.invoke(IpcChannels.UiStateSave, state),
	pickBackgroundImage: () => ipcRenderer.invoke(IpcChannels.BackgroundPick),
	checkForUpdates: () => ipcRenderer.invoke(IpcChannels.UpdateCheck),
	downloadUpdate: () => ipcRenderer.invoke(IpcChannels.UpdateDownload),
	installUpdate: () => ipcRenderer.invoke(IpcChannels.UpdateInstall),
	uiPluginsGetConfig: () => ipcRenderer.invoke(IpcChannels.UiPluginsGetConfig),
	uiPluginsSetEnabled: (enabled) => ipcRenderer.invoke(IpcChannels.UiPluginsSetEnabled, enabled),
	uiPluginsList: () => ipcRenderer.invoke(IpcChannels.UiPluginsList),
	uiPluginsReadCode: (name) => ipcRenderer.invoke(IpcChannels.UiPluginsReadCode, name),
	uiPluginsSetPluginEnabled: (name, enabled) =>
		ipcRenderer.invoke(IpcChannels.UiPluginsSetPluginEnabled, name, enabled),
	uiPluginsAssignSlot: (slot, pluginName) =>
		ipcRenderer.invoke(IpcChannels.UiPluginsAssignSlot, slot, pluginName),
	uiPluginsRebuild: (name) => ipcRenderer.invoke(IpcChannels.UiPluginsRebuild, name),
	uiPluginsOpenDir: (name) => ipcRenderer.invoke(IpcChannels.UiPluginsOpenDir, name),
	onUiPluginsEvent: makeSubscription<UiPluginsEventPayload>(IpcChannels.UiPluginsEvent),
	onUpdateEvent: makeSubscription<UpdateState>(IpcChannels.UpdateEvent),
	onEvent: makeSubscription<SessionEventEnvelope>(IpcChannels.Event),
	onPermissionRequest: makeSubscription<PermissionRequest>(IpcChannels.PermissionRequest),
	onPermissionResolved: makeSubscription<PermissionResolved>(IpcChannels.PermissionResolved),
	onTrustRequest: makeSubscription<TrustRequest>(IpcChannels.TrustRequest),
	respondExtensionDialog: (requestId, answer) =>
		ipcRenderer.invoke(IpcChannels.ExtensionDialogRespond, requestId, answer),
	onExtensionDialogRequest: makeSubscription<ExtensionDialogRequest>(IpcChannels.ExtensionDialogRequest),
	onExtensionDialogResolved: makeSubscription<ExtensionDialogResolved>(IpcChannels.ExtensionDialogResolved),
	onExtensionNotify: makeSubscription<ExtensionNotifyEvent>(IpcChannels.ExtensionNotify),
	onExtensionEditorText: makeSubscription<ExtensionEditorTextEvent>(IpcChannels.ExtensionEditorText),
};

contextBridge.exposeInMainWorld("pi", api);
