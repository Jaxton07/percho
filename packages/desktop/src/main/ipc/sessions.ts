import type { PiBackend } from "@percho/backend";
import type { ImageInput } from "@percho/shared";
import { IpcChannels } from "@percho/shared";
import { ipcMain } from "electron";

/** 会话域：Session* 通道（生命周期/提示/导出/fork/撤回）+ 模型列表 + 项目文件/信任 */
export function registerSessionsIpc(backend: PiBackend): void {
	ipcMain.handle(
		IpcChannels.SessionCreate,
		(_e, options: { cwd: string; provider?: string; modelId?: string; thinkingLevel?: string }) =>
			backend.createSession(options),
	);
	ipcMain.handle(IpcChannels.SessionList, (_e, cwd?: string) => backend.listSessions(cwd));
	ipcMain.handle(IpcChannels.SessionListAll, () => backend.listAllSessions());
	ipcMain.handle(IpcChannels.SessionOpen, (_e, filePath: string) => backend.openSession(filePath));
	ipcMain.handle(IpcChannels.SessionClose, (_e, sessionId: string) => backend.closeSession(sessionId));
	ipcMain.handle(IpcChannels.SessionDelete, (_e, sessionId: string, sessionFile?: string) =>
		backend.deleteSession(sessionId, sessionFile),
	);
	ipcMain.handle(IpcChannels.SessionPrompt, (_e, sessionId: string, text: string, images?: ImageInput[]) =>
		backend.prompt(sessionId, text, images),
	);
	ipcMain.handle(IpcChannels.SessionAbort, (_e, sessionId: string) => backend.abort(sessionId));
	ipcMain.handle(IpcChannels.SessionSetModel, (_e, sessionId: string, provider: string, modelId: string) =>
		backend.setModel(sessionId, provider, modelId),
	);
	ipcMain.handle(IpcChannels.SessionSetThinkingLevel, (_e, sessionId: string, level: string) =>
		backend.setThinkingLevel(sessionId, level),
	);
	ipcMain.handle(IpcChannels.SessionCompact, (_e, sessionId: string, customInstructions?: string) =>
		backend.compact(sessionId, customInstructions),
	);
	ipcMain.handle(IpcChannels.SessionStats, (_e, sessionId: string) => backend.getStats(sessionId));
	ipcMain.handle(IpcChannels.SessionGetContextUsage, (_e, sessionId: string) =>
		backend.getContextUsage(sessionId),
	);
	ipcMain.handle(IpcChannels.SessionClearQueue, (_e, sessionId: string) => backend.clearQueue(sessionId));
	ipcMain.handle(IpcChannels.SessionGetFollowUpMessages, (_e, sessionId: string) =>
		backend.getFollowUpMessages(sessionId),
	);
	ipcMain.handle(IpcChannels.SessionListSlashCommands, (_e, sessionId: string) =>
		backend.listSlashCommands(sessionId),
	);
	ipcMain.handle(IpcChannels.SessionListSlashCommandsForCwd, (_e, cwd?: string) =>
		backend.listSlashCommandsForCwd(cwd),
	);
	ipcMain.handle(IpcChannels.SessionSetName, (_e, sessionId: string, name: string) =>
		backend.setSessionName(sessionId, name),
	);
	ipcMain.handle(IpcChannels.SessionExport, (_e, sessionId: string, format: "html" | "jsonl") =>
		backend.exportSession(sessionId, format),
	);
	ipcMain.handle(IpcChannels.SessionFork, (_e, sessionId: string, ref: { entryId?: string; text?: string }) =>
		backend.forkSession(sessionId, ref),
	);
	ipcMain.handle(
		IpcChannels.SessionRecall,
		(_e, sessionId: string, ref: { entryId?: string; text?: string; timestamp?: number }) =>
			backend.recallMessage(sessionId, ref),
	);
	ipcMain.handle(IpcChannels.SessionGetLoadedResources, (_e, sessionId: string) =>
		backend.getLoadedResources(sessionId),
	);
	ipcMain.handle(IpcChannels.SessionGetMessages, (_e, sessionId: string) =>
		backend.getSessionMessages(sessionId),
	);
	ipcMain.handle(IpcChannels.SessionGetTodos, (_e, sessionId: string) => backend.getTodos(sessionId));
	ipcMain.handle(IpcChannels.ModelsList, () => backend.listModels());
	ipcMain.handle(IpcChannels.ProjectListFiles, (_e, cwd?: string) => backend.listProjectFiles(cwd));
	ipcMain.handle(IpcChannels.ProjectEnsureTrust, (_e, cwd: string) => backend.ensureProjectTrust(cwd));
}
