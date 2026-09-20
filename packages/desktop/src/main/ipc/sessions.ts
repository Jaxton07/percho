import type { PiBackend } from "@percho/backend";
import { SESSION_CHANNELS } from "@percho/shared";
import { registerInvokeHandlers } from "./invoke";

/** 会话域：Session* 通道（生命周期/提示/导出/fork/撤回）+ 模型列表 + 项目文件/信任 */
export function registerSessionsIpc(backend: PiBackend): void {
	// 已表化通道（shared/ipc-channels.ts SESSION_CHANNELS）：handler 与通道定义同源校验
	registerInvokeHandlers(SESSION_CHANNELS, {
		createSession: ({ options }) => backend.createSession(options),
		listSessions: ({ cwd }) => backend.listSessions(cwd),
		listAllSessions: () => backend.listAllSessions(),
		openSession: ({ filePath }) => backend.openSession(filePath),
		closeSession: ({ sessionId, intent }) => backend.closeSession(sessionId, intent),
		getChannelSubscriptionSessionIds: () => backend.getChannelSubscriptionSessionIds(),
		deleteSession: ({ sessionId, sessionFile }) => backend.deleteSession(sessionId, sessionFile),
		prompt: ({ sessionId, text, images }) => backend.prompt(sessionId, text, images),
		abort: ({ sessionId }) => backend.abort(sessionId),
		setModel: ({ sessionId, provider, modelId }) => backend.setModel(sessionId, provider, modelId),
		setThinkingLevel: ({ sessionId, level }) => backend.setThinkingLevel(sessionId, level),
		getSessionMessages: ({ sessionId }) => backend.getSessionMessages(sessionId),
		getTodos: ({ sessionId }) => backend.getTodos(sessionId),
		compact: ({ sessionId, customInstructions }) => backend.compact(sessionId, customInstructions),
		getStats: ({ sessionId }) => backend.getStats(sessionId),
		getContextUsage: ({ sessionId }) => backend.getContextUsage(sessionId),
		getQuota: () => backend.getQuota(),
		clearQueue: ({ sessionId }) => backend.clearQueue(sessionId),
		getFollowUpMessages: ({ sessionId }) => backend.getFollowUpMessages(sessionId),
		listSlashCommands: ({ sessionId }) => backend.listSlashCommands(sessionId),
		listSlashCommandsForCwd: ({ cwd }) => backend.listSlashCommandsForCwd(cwd),
		setSessionName: ({ sessionId, name }) => backend.setSessionName(sessionId, name),
		exportSession: ({ sessionId, format }) => backend.exportSession(sessionId, format),
		forkSession: ({ sessionId, ref }) => backend.forkSession(sessionId, ref),
		recallMessage: ({ sessionId, ref }) => backend.recallMessage(sessionId, ref),
		getLoadedResources: ({ sessionId }) => backend.getLoadedResources(sessionId),
		listModels: () => backend.listModels(),
		listProjectFiles: ({ cwd }) => backend.listProjectFiles(cwd),
		ensureProjectTrust: ({ cwd }) => backend.ensureProjectTrust(cwd),
	});
}
