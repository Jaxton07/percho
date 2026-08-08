import { IpcChannels, type PiApi, type SessionEventEnvelope } from "@pi-desktop/shared";
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
	compact: (sessionId) => ipcRenderer.invoke(IpcChannels.SessionCompact, sessionId),
	getStats: (sessionId) => ipcRenderer.invoke(IpcChannels.SessionStats, sessionId),
	getContextUsage: (sessionId) => ipcRenderer.invoke(IpcChannels.SessionGetContextUsage, sessionId),
	clearQueue: (sessionId) => ipcRenderer.invoke(IpcChannels.SessionClearQueue, sessionId),
	getFollowUpMessages: (sessionId) => ipcRenderer.invoke(IpcChannels.SessionGetFollowUpMessages, sessionId),
	listSlashCommands: (sessionId) => ipcRenderer.invoke(IpcChannels.SessionListSlashCommands, sessionId),
	setSessionName: (sessionId, name) => ipcRenderer.invoke(IpcChannels.SessionSetName, sessionId, name),
	exportSession: (sessionId, format) => ipcRenderer.invoke(IpcChannels.SessionExport, sessionId, format),
	saveFileDialog: (defaultName, content) =>
		ipcRenderer.invoke(IpcChannels.FileSaveDialog, defaultName, content),
	getSessionMessages: (sessionId) => ipcRenderer.invoke(IpcChannels.SessionGetMessages, sessionId),
	listModels: () => ipcRenderer.invoke(IpcChannels.ModelsList),
	listProviders: () => ipcRenderer.invoke(IpcChannels.SettingsListProviders),
	saveApiKey: (providerId, key) => ipcRenderer.invoke(IpcChannels.SettingsSaveApiKey, providerId, key),
	removeCredential: (providerId) => ipcRenderer.invoke(IpcChannels.SettingsRemoveCredential, providerId),
	addCustomProvider: (input) => ipcRenderer.invoke(IpcChannels.SettingsAddCustomProvider, input),
	removeCustomProvider: (providerId) =>
		ipcRenderer.invoke(IpcChannels.SettingsRemoveCustomProvider, providerId),
	testProvider: (providerId, modelId) =>
		ipcRenderer.invoke(IpcChannels.SettingsTestProvider, providerId, modelId),
	respondPermission: (requestId, answer) =>
		ipcRenderer.invoke(IpcChannels.PermissionRespond, requestId, answer),
	getPermissionConfig: () => ipcRenderer.invoke(IpcChannels.PermissionGetConfig),
	setPermissionEnabled: (enabled) => ipcRenderer.invoke(IpcChannels.PermissionSetEnabled, enabled),
	respondTrust: (requestId, answer) => ipcRenderer.invoke(IpcChannels.TrustRespond, requestId, answer),
	pickDirectory: () => ipcRenderer.invoke(IpcChannels.ProjectPickDirectory),
	getGitBranch: (cwd) => ipcRenderer.invoke(IpcChannels.ProjectGetGitBranch, cwd),
	listGitBranches: (cwd) => ipcRenderer.invoke(IpcChannels.ProjectListGitBranches, cwd),
	checkoutBranch: (cwd, branch) => ipcRenderer.invoke(IpcChannels.ProjectCheckoutBranch, cwd, branch),
	openExternal: (url) => ipcRenderer.invoke(IpcChannels.AppOpenExternal, url),
	loadTabs: () => ipcRenderer.invoke(IpcChannels.TabsLoad),
	saveTabs: (tabs) => ipcRenderer.invoke(IpcChannels.TabsSave, tabs),
	loadUiState: () => ipcRenderer.invoke(IpcChannels.UiStateLoad),
	saveUiState: (state) => ipcRenderer.invoke(IpcChannels.UiStateSave, state),
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
