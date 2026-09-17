import type { PiBackend } from "@percho/backend";
import { SETTINGS_CHANNELS } from "@percho/shared";
import { registerInvokeHandlers } from "./invoke";

/** 设置域：provider 设置 + 权限门控配置 + 项目信任应答 */
export function registerSettingsIpc(backend: PiBackend): void {
	registerInvokeHandlers(SETTINGS_CHANNELS, {
		listProviders: ({ options }) => backend.settings.listProviders(options),
		saveApiKey: ({ providerId, key }) => backend.settings.saveApiKey(providerId, key),
		removeCredential: ({ providerId }) => backend.settings.removeCredential(providerId),
		addCustomProvider: ({ input }) => backend.settings.addCustomProvider(input),
		updateCustomProvider: ({ input }) => backend.settings.updateCustomProvider(input),
		removeCustomProvider: ({ providerId }) => backend.settings.removeCustomProvider(providerId),
		setProviderBaseUrl: ({ providerId, baseUrl, apiKey }) =>
			backend.settings.setProviderBaseUrl(providerId, baseUrl, apiKey),
		testProvider: ({ providerId, modelId }) => backend.settings.testProvider(providerId, modelId),
		getModelPrefs: () => backend.modelPrefs.getPrefs(),
		setModelHidden: ({ provider, modelId, hidden }) =>
			backend.modelPrefs.setModelHidden(provider, modelId, hidden),
		setModelsHidden: ({ provider, modelIds, hidden }) =>
			backend.modelPrefs.setModelsHidden(provider, modelIds, hidden),
		setSubagentModel: ({ agent, modelRef }) => backend.modelPrefs.setSubagentModel(agent, modelRef),
		setSubagentThinking: ({ agent, level }) => backend.modelPrefs.setSubagentThinking(agent, level),
		setSubagentPreferBuiltin: ({ enabled }) => backend.modelPrefs.setSubagentPreferBuiltin(enabled),
		listSubagents: () => backend.listSubagents(),
		startProviderLogin: ({ loginId, providerId }) => backend.login.startLogin(loginId, providerId),
		cancelProviderLogin: ({ loginId }) => backend.login.cancel(loginId),
		respondProviderLogin: ({ loginId, promptId, value }) => backend.login.respond(loginId, promptId, value),
		respondPermission: ({ requestId, answer }) => backend.respondPermission(requestId, answer),
		getPermissionConfig: () => backend.getPermissionConfig(),
		getPermissionMode: ({ sessionId }) => backend.getSessionPermissionMode(sessionId),
		setPermissionMode: ({ sessionId, mode }) => backend.setSessionPermissionMode(sessionId, mode),
		getContextManagerConfig: () => backend.getContextManagerConfig(),
		setContextManagerMode: ({ mode }) => backend.setContextManagerMode(mode),
		getChannelWatchConfig: () => backend.getChannelWatchConfig(),
		setChannelWatchEnabled: ({ enabled }) => backend.setChannelWatchEnabled(enabled),
		respondTrust: ({ requestId, answer }) => backend.respondTrust(requestId, answer),
	});
}
