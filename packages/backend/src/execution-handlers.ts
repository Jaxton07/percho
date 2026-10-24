import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { EnvironmentHandlers } from "@percho/shared";
import { checkoutBranch, getGitBranch, listGitBranches } from "./git";
import { resolveExistingPath } from "./path-target";
import type { PiBackend } from "./pi-backend";
import { validateProjectDirectory } from "./project/directory";

/** Explicit implementations share the existing IPC method identities; there is no backend reflection. */
export function createExecutionHandlers(
	backend: PiBackend,
	options: { getDailyDir?: () => Promise<string>; allowInteractiveAuth?: boolean } = {},
): EnvironmentHandlers {
	return {
		validateProjectDirectory: ({ path }) => validateProjectDirectory(path),
		createSession: ({ options }) => backend.createSession(options),
		listSessions: ({ cwd }) => backend.listSessions(cwd),
		listAllSessions: () => backend.listAllSessions(),
		openSession: ({ filePath }) => backend.openSession(filePath),
		closeSession: ({ sessionId, intent }) => backend.closeSession(sessionId, intent),
		getChannelSubscriptionSessionIds: () => backend.getChannelSubscriptionSessionIds(),
		deleteSession: ({ sessionId, sessionFile }) => backend.deleteSession(sessionId, sessionFile),
		prompt: ({ sessionId, text, images, document }) => backend.prompt(sessionId, text, images, document),
		retryLastFailedTurn: ({ sessionId, ref }) => backend.retryLastFailedTurn(sessionId, ref),
		abort: ({ sessionId }) => backend.abort(sessionId),
		setModel: ({ sessionId, provider, modelId }) => backend.setModel(sessionId, provider, modelId),
		setThinkingLevel: ({ sessionId, level }) => backend.setThinkingLevel(sessionId, level),
		getPendingInteractions: () => backend.getPendingInteractions(),
		getLoadedSessions: () => backend.getLoadedSessions(),
		getSessionBaseline: ({ sessionId }) => backend.getSessionBaseline(sessionId),
		getSessionMessages: ({ sessionId }) => backend.getSessionMessages(sessionId),
		markSessionHistoryReady: ({ sessionId }) => backend.markSessionHistoryReady(sessionId),
		getTodos: ({ sessionId }) => backend.getTodos(sessionId),
		compact: ({ sessionId, customInstructions }) => backend.compact(sessionId, customInstructions),
		getStats: ({ sessionId }) => backend.getStats(sessionId),
		getContextUsage: ({ sessionId }) => backend.getContextUsage(sessionId),
		getQuota: () => backend.getQuota(),
		clearQueue: ({ sessionId }) => backend.clearQueue(sessionId),
		getFollowUpMessages: ({ sessionId }) => backend.getFollowUpMessages(sessionId),
		listSlashCommands: ({ sessionId }) => backend.listSlashCommands(sessionId),
		listSlashCommandsForCwd: ({ cwd }) => backend.listSlashCommandsForCwd(cwd),
		setSessionName: ({ sessionId, name, cwd }) => backend.setSessionName(sessionId, name, cwd),
		exportSession: ({ sessionId, format }) => backend.exportSession(sessionId, format),
		forkSession: ({ sessionId, ref }) => backend.forkSession(sessionId, ref),
		recallMessage: ({ sessionId, ref }) => backend.recallMessage(sessionId, ref),
		getLoadedResources: ({ sessionId }) => backend.getLoadedResources(sessionId),
		getChannelSubscriptions: ({ sessionId }) => backend.getChannelSubscriptions(sessionId),
		listModels: () => backend.listModels(),
		listProjectFiles: ({ cwd }) => backend.listProjectFiles(cwd),
		ensureProjectTrust: ({ cwd }) => backend.ensureProjectTrust(cwd),
		mcpConfigList: ({ cwd }) => backend.getMcpConfig({ cwd }),
		mcpConfigUpsert: (input) => backend.upsertMcpServer(input),
		mcpConfigRemove: (input) => backend.removeMcpServer(input),
		mcpConfigReload: ({ cwd }) => backend.reloadMcpServers({ cwd }),
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
		setProviderModelsHidden: ({ provider, hidden }) =>
			backend.modelPrefs.setProviderModelsHidden(provider, hidden),
		setSubagentModel: ({ agent, modelRef }) => backend.modelPrefs.setSubagentModel(agent, modelRef),
		setSubagentThinking: ({ agent, level }) => backend.modelPrefs.setSubagentThinking(agent, level),
		setSubagentPreferBuiltin: ({ enabled }) => backend.modelPrefs.setSubagentPreferBuiltin(enabled),
		listSubagents: () => backend.listSubagents(),
		startProviderLogin: ({ loginId, providerId }) => {
			if (options.allowInteractiveAuth === false)
				throw new Error(
					"Remote interactive login is unavailable in the desktop. Stop the service and use its same-version auth maintenance entry.",
				);
			return backend.login.startLogin(loginId, providerId);
		},
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
		searchCatalog: ({ query, type, page }) => backend.packages.searchPackages(query, type, page),
		installPackage: ({ name }) => backend.packages.installPackage(name),
		removePackage: ({ source, scope }) => backend.packages.removePackage(source, scope),
		listConfiguredPackages: () => backend.packages.listConfiguredPackages(),
		respondExtensionDialog: ({ requestId, answer }) => backend.respondExtensionDialog(requestId, answer),
		getGitBranch: ({ cwd }) => getGitBranch(cwd),
		listGitBranches: ({ cwd }) => listGitBranches(cwd),
		checkoutBranch: ({ cwd, branch }) => checkoutBranch(cwd, branch),
		resolvePath: ({ target, cwd }) => resolveExistingPath(target, cwd),
		getDailyDir:
			options.getDailyDir ??
			(async () => {
				const directory = join(getAgentDir(), "daily");
				await mkdir(directory, { recursive: true });
				return directory;
			}),
	};
}
