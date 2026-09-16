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
	listAllSessions: () => ipcRenderer.invoke(IpcChannels.SessionListAll),
	openSession: (filePath) => ipcRenderer.invoke(IpcChannels.SessionOpen, filePath),
	closeSession: (sessionId) => ipcRenderer.invoke(IpcChannels.SessionClose, sessionId),
	deleteSession: (sessionId, sessionFile) =>
		ipcRenderer.invoke(IpcChannels.SessionDelete, sessionId, sessionFile),
	prompt: (sessionId, text, images) => ipcRenderer.invoke(IpcChannels.SessionPrompt, sessionId, text, images),
	abort: (sessionId) => ipcRenderer.invoke(IpcChannels.SessionAbort, sessionId),
	setThinkingLevel: (sessionId, level) =>
		ipcRenderer.invoke(IpcChannels.SessionSetThinkingLevel, sessionId, level),
	compact: (sessionId, customInstructions) =>
		ipcRenderer.invoke(IpcChannels.SessionCompact, sessionId, customInstructions),
	getStats: (sessionId) => ipcRenderer.invoke(IpcChannels.SessionStats, sessionId),
	getContextUsage: (sessionId) => ipcRenderer.invoke(IpcChannels.SessionGetContextUsage, sessionId),
	clearQueue: (sessionId) => ipcRenderer.invoke(IpcChannels.SessionClearQueue, sessionId),
	getFollowUpMessages: (sessionId) => ipcRenderer.invoke(IpcChannels.SessionGetFollowUpMessages, sessionId),
	listSlashCommands: (sessionId) => ipcRenderer.invoke(IpcChannels.SessionListSlashCommands, sessionId),
	listSlashCommandsForCwd: (cwd) => ipcRenderer.invoke(IpcChannels.SessionListSlashCommandsForCwd, cwd),
	setSessionName: (sessionId, name) => ipcRenderer.invoke(IpcChannels.SessionSetName, sessionId, name),
	exportSession: (sessionId, format) => ipcRenderer.invoke(IpcChannels.SessionExport, sessionId, format),
	forkSession: (sessionId, ref) => ipcRenderer.invoke(IpcChannels.SessionFork, sessionId, ref),
	recallMessage: (sessionId, ref) => ipcRenderer.invoke(IpcChannels.SessionRecall, sessionId, ref),
	getLoadedResources: (sessionId) => ipcRenderer.invoke(IpcChannels.SessionGetLoadedResources, sessionId),
	installPackage: (name) => ipcRenderer.invoke(IpcChannels.PackagesInstall, name),
	removePackage: (source, scope) => ipcRenderer.invoke(IpcChannels.PackagesRemove, source, scope),
	listConfiguredPackages: () => ipcRenderer.invoke(IpcChannels.PackagesListConfigured),
	saveFileDialog: (defaultName, content) =>
		ipcRenderer.invoke(IpcChannels.FileSaveDialog, defaultName, content),
	getSessionMessages: (sessionId) => ipcRenderer.invoke(IpcChannels.SessionGetMessages, sessionId),
	getTodos: (sessionId) => ipcRenderer.invoke(IpcChannels.SessionGetTodos, sessionId),
	listModels: () => ipcRenderer.invoke(IpcChannels.ModelsList),
	listProviders: (options) => ipcRenderer.invoke(IpcChannels.SettingsListProviders, options),
	saveApiKey: (providerId, key) => ipcRenderer.invoke(IpcChannels.SettingsSaveApiKey, providerId, key),
	removeCredential: (providerId) => ipcRenderer.invoke(IpcChannels.SettingsRemoveCredential, providerId),
	addCustomProvider: (input) => ipcRenderer.invoke(IpcChannels.SettingsAddCustomProvider, input),
	updateCustomProvider: (input) => ipcRenderer.invoke(IpcChannels.SettingsUpdateCustomProvider, input),
	removeCustomProvider: (providerId) =>
		ipcRenderer.invoke(IpcChannels.SettingsRemoveCustomProvider, providerId),
	setProviderBaseUrl: (providerId, baseUrl, apiKey) =>
		ipcRenderer.invoke(IpcChannels.SettingsSetProviderBaseUrl, providerId, baseUrl, apiKey),
	testProvider: (providerId, modelId) =>
		ipcRenderer.invoke(IpcChannels.SettingsTestProvider, providerId, modelId),
	getModelPrefs: () => ipcRenderer.invoke(IpcChannels.SettingsGetModelPrefs),
	setModelHidden: (provider, modelId, hidden) =>
		ipcRenderer.invoke(IpcChannels.SettingsSetModelHidden, provider, modelId, hidden),
	setModelsHidden: (provider, modelIds, hidden) =>
		ipcRenderer.invoke(IpcChannels.SettingsSetModelsHidden, provider, modelIds, hidden),
	setSubagentModel: (agent, modelRef) =>
		ipcRenderer.invoke(IpcChannels.SettingsSetSubagentModel, agent, modelRef),
	setSubagentThinking: (agent, level) =>
		ipcRenderer.invoke(IpcChannels.SettingsSetSubagentThinking, agent, level),
	setSubagentPreferBuiltin: (enabled) =>
		ipcRenderer.invoke(IpcChannels.SettingsSetSubagentPreferBuiltin, enabled),
	listSubagents: () => ipcRenderer.invoke(IpcChannels.SettingsListSubagents),
	startProviderLogin: (loginId, providerId) =>
		ipcRenderer.invoke(IpcChannels.SettingsLoginStart, loginId, providerId),
	cancelProviderLogin: (loginId) => ipcRenderer.invoke(IpcChannels.SettingsLoginCancel, loginId),
	respondProviderLogin: (loginId, promptId, value) =>
		ipcRenderer.invoke(IpcChannels.SettingsLoginRespond, loginId, promptId, value),
	onProviderLoginEvent: makeSubscription<LoginEventPayload>(IpcChannels.SettingsLoginEvent),
	respondPermission: (requestId, answer) =>
		ipcRenderer.invoke(IpcChannels.PermissionRespond, requestId, answer),
	getPermissionConfig: () => ipcRenderer.invoke(IpcChannels.PermissionGetConfig),
	getPermissionMode: (sessionId) => ipcRenderer.invoke(IpcChannels.PermissionGetMode, sessionId),
	setPermissionMode: (sessionId, mode) => ipcRenderer.invoke(IpcChannels.PermissionSetMode, sessionId, mode),
	getContextManagerConfig: () => ipcRenderer.invoke(IpcChannels.ContextManagerGetConfig),
	setContextManagerMode: (mode) => ipcRenderer.invoke(IpcChannels.ContextManagerSetMode, mode),
	getChannelWatchConfig: () => ipcRenderer.invoke(IpcChannels.ChannelWatchGetConfig),
	setChannelWatchEnabled: (enabled) => ipcRenderer.invoke(IpcChannels.ChannelWatchSetEnabled, enabled),
	lanGetStatus: () => ipcRenderer.invoke(IpcChannels.LanGetStatus),
	lanSetEnabled: (enabled) => ipcRenderer.invoke(IpcChannels.LanSetEnabled, enabled),
	lanSetRemoteControl: (enabled) => ipcRenderer.invoke(IpcChannels.LanSetRemoteControl, enabled),
	respondTrust: (requestId, answer) => ipcRenderer.invoke(IpcChannels.TrustRespond, requestId, answer),
	ensureProjectTrust: (cwd) => ipcRenderer.invoke(IpcChannels.ProjectEnsureTrust, cwd),
	pickDirectory: () => ipcRenderer.invoke(IpcChannels.ProjectPickDirectory),
	listProjectFiles: (cwd) => ipcRenderer.invoke(IpcChannels.ProjectListFiles, cwd),
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
