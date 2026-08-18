import {
	IpcChannels,
	type PiApi,
	type SessionEventEnvelope,
	type UiPluginsEventPayload,
	type UpdateState,
} from "@percho/shared";
import { contextBridge, ipcRenderer } from "electron";

const api: PiApi = {
	createSession: (options) => ipcRenderer.invoke(IpcChannels.SessionCreate, options),
	listSessions: (cwd) => ipcRenderer.invoke(IpcChannels.SessionList, cwd),
	listAllSessions: () => ipcRenderer.invoke(IpcChannels.SessionListAll),
	openSession: (filePath) => ipcRenderer.invoke(IpcChannels.SessionOpen, filePath),
	closeSession: (sessionId) => ipcRenderer.invoke(IpcChannels.SessionClose, sessionId),
	deleteSession: (sessionId, sessionFile) =>
		ipcRenderer.invoke(IpcChannels.SessionDelete, sessionId, sessionFile),
	prompt: (sessionId, text, images) => ipcRenderer.invoke(IpcChannels.SessionPrompt, sessionId, text, images),
	abort: (sessionId) => ipcRenderer.invoke(IpcChannels.SessionAbort, sessionId),
	setModel: (sessionId, provider, modelId) =>
		ipcRenderer.invoke(IpcChannels.SessionSetModel, sessionId, provider, modelId),
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
	searchCatalog: (query, type, page) =>
		ipcRenderer.invoke(IpcChannels.PackagesSearchCatalog, query, type, page),
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
	testProvider: (providerId, modelId) =>
		ipcRenderer.invoke(IpcChannels.SettingsTestProvider, providerId, modelId),
	respondPermission: (requestId, answer) =>
		ipcRenderer.invoke(IpcChannels.PermissionRespond, requestId, answer),
	getPermissionConfig: () => ipcRenderer.invoke(IpcChannels.PermissionGetConfig),
	setPermissionEnabled: (enabled) => ipcRenderer.invoke(IpcChannels.PermissionSetEnabled, enabled),
	getVisionConfig: () => ipcRenderer.invoke(IpcChannels.VisionGetConfig),
	saveVisionConfig: (input) => ipcRenderer.invoke(IpcChannels.VisionSaveConfig, input),
	testVision: () => ipcRenderer.invoke(IpcChannels.VisionTest),
	setVisionLanguage: (language) => ipcRenderer.invoke(IpcChannels.VisionSetLanguage, language),
	respondTrust: (requestId, answer) => ipcRenderer.invoke(IpcChannels.TrustRespond, requestId, answer),
	ensureProjectTrust: (cwd) => ipcRenderer.invoke(IpcChannels.ProjectEnsureTrust, cwd),
	pickDirectory: () => ipcRenderer.invoke(IpcChannels.ProjectPickDirectory),
	listProjectFiles: (cwd) => ipcRenderer.invoke(IpcChannels.ProjectListFiles, cwd),
	getGitBranch: (cwd) => ipcRenderer.invoke(IpcChannels.ProjectGetGitBranch, cwd),
	listGitBranches: (cwd) => ipcRenderer.invoke(IpcChannels.ProjectListGitBranches, cwd),
	checkoutBranch: (cwd, branch) => ipcRenderer.invoke(IpcChannels.ProjectCheckoutBranch, cwd, branch),
	openExternal: (url) => ipcRenderer.invoke(IpcChannels.AppOpenExternal, url),
	getAppInfo: () => ipcRenderer.invoke(IpcChannels.AppGetInfo),
	loadTabs: () => ipcRenderer.invoke(IpcChannels.TabsLoad),
	saveTabs: (tabs) => ipcRenderer.invoke(IpcChannels.TabsSave, tabs),
	loadUiState: () => ipcRenderer.invoke(IpcChannels.UiStateLoad),
	saveUiState: (state) => ipcRenderer.invoke(IpcChannels.UiStateSave, state),
	pickBackgroundImage: () => ipcRenderer.invoke(IpcChannels.BackgroundPick),
	checkForUpdates: () => ipcRenderer.invoke(IpcChannels.UpdateCheck),
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
	onUiPluginsEvent: (cb) => {
		const listener = (_event: unknown, payload: UiPluginsEventPayload) => cb(payload);
		ipcRenderer.on(IpcChannels.UiPluginsEvent, listener);
		return () => ipcRenderer.removeListener(IpcChannels.UiPluginsEvent, listener);
	},
	onUpdateEvent: (cb) => {
		const listener = (_event: unknown, state: UpdateState) => cb(state);
		ipcRenderer.on(IpcChannels.UpdateEvent, listener);
		return () => ipcRenderer.removeListener(IpcChannels.UpdateEvent, listener);
	},
	onEvent: (cb) => {
		const listener = (_event: unknown, payload: SessionEventEnvelope) => cb(payload);
		ipcRenderer.on(IpcChannels.Event, listener);
		return () => ipcRenderer.removeListener(IpcChannels.Event, listener);
	},
	onPermissionRequest: (cb) => {
		const listener = (_event: unknown, req: Parameters<typeof cb>[0]) => cb(req);
		ipcRenderer.on(IpcChannels.PermissionRequest, listener);
		return () => ipcRenderer.removeListener(IpcChannels.PermissionRequest, listener);
	},
	onTrustRequest: (cb) => {
		const listener = (_event: unknown, req: Parameters<typeof cb>[0]) => cb(req);
		ipcRenderer.on(IpcChannels.TrustRequest, listener);
		return () => ipcRenderer.removeListener(IpcChannels.TrustRequest, listener);
	},
};

contextBridge.exposeInMainWorld("pi", api);
