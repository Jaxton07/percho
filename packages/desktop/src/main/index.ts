import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createLogger, initLogging, PiBackend } from "@pi-desktop/backend";
import {
	type CustomProviderInput,
	type ImageInput,
	IpcChannels,
	type PermissionAnswer,
	type PermissionRequest,
	type SavedTabs,
	type ThemeMode,
	type TrustRequest,
	type UiState,
} from "@pi-desktop/shared";
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, net, protocol, shell } from "electron";
import { backgroundsDir, pickBackgroundImage } from "./background";
import { checkoutBranch, getGitBranch, listGitBranches } from "./git";
import { loadTabs, saveTabs } from "./tabs";
import { loadUiState, saveUiState } from "./ui-state";
import { createWindow } from "./window";

const log = createLogger("main");
let backend: PiBackend;

/** renderer 加载自定义背景图的协议（pi-bg://background/<文件名>，只读 userData/backgrounds/） */
const BG_PROTOCOL = "pi-bg";

protocol.registerSchemesAsPrivileged([
	{ scheme: BG_PROTOCOL, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

/** 窗口启动底色跟随主题，避免深色模式下启动白闪 */
function resolveWindowBackground(theme: ThemeMode | undefined): string {
	const dark = theme === "dark" || (theme !== "light" && nativeTheme.shouldUseDarkColors);
	return dark ? "#17171a" : "#fafafa";
}

function sendToRenderer(channel: string, payload: unknown): void {
	const window = BrowserWindow.getAllWindows()[0];
	if (window && !window.isDestroyed()) {
		window.webContents.send(channel, payload);
	}
}

function registerIpc(): void {
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
	ipcMain.handle(IpcChannels.SessionSetName, (_e, sessionId: string, name: string) =>
		backend.setSessionName(sessionId, name),
	);
	ipcMain.handle(IpcChannels.SessionExport, (_e, sessionId: string, format: "html" | "jsonl") =>
		backend.exportSession(sessionId, format),
	);
	ipcMain.handle(IpcChannels.SessionFork, (_e, sessionId: string, ref: { entryId?: string; text?: string }) =>
		backend.forkSession(sessionId, ref),
	);
	ipcMain.handle(IpcChannels.FileSaveDialog, async (_e, defaultName: string, content: string) => {
		const window = BrowserWindow.getAllWindows()[0];
		const options: Electron.SaveDialogOptions = {
			defaultPath: defaultName,
			filters: [{ name: "All Files", extensions: ["*"] }],
		};
		const result = window
			? await dialog.showSaveDialog(window, options)
			: await dialog.showSaveDialog(options);
		if (result.canceled || !result.filePath) return null;
		await writeFile(result.filePath, content, "utf-8");
		return result.filePath;
	});
	ipcMain.handle(IpcChannels.SessionGetMessages, (_e, sessionId: string) =>
		backend.getSessionMessages(sessionId),
	);
	ipcMain.handle(IpcChannels.ModelsList, () => backend.listModels());
	ipcMain.handle(IpcChannels.SettingsListProviders, () => backend.settings.listProviders());
	ipcMain.handle(IpcChannels.SettingsSaveApiKey, (_e, providerId: string, key: string) =>
		backend.settings.saveApiKey(providerId, key),
	);
	ipcMain.handle(IpcChannels.SettingsRemoveCredential, (_e, providerId: string) =>
		backend.settings.removeCredential(providerId),
	);
	ipcMain.handle(IpcChannels.SettingsAddCustomProvider, (_e, input: CustomProviderInput) =>
		backend.settings.addCustomProvider(input),
	);
	ipcMain.handle(IpcChannels.SettingsRemoveCustomProvider, (_e, providerId: string) =>
		backend.settings.removeCustomProvider(providerId),
	);
	ipcMain.handle(IpcChannels.SettingsTestProvider, (_e, providerId: string, modelId?: string) =>
		backend.settings.testProvider(providerId, modelId),
	);
	ipcMain.handle(IpcChannels.PermissionRespond, (_e, requestId: string, answer: PermissionAnswer) =>
		backend.respondPermission(requestId, answer),
	);
	ipcMain.handle(IpcChannels.PermissionGetConfig, () => backend.getPermissionConfig());
	ipcMain.handle(IpcChannels.PermissionSetEnabled, (_e, enabled: boolean) =>
		backend.setPermissionEnabled(enabled),
	);
	ipcMain.handle(IpcChannels.TrustRespond, (_e, requestId: string, answer: number) =>
		backend.respondTrust(requestId, answer),
	);
	ipcMain.handle(IpcChannels.ProjectGetGitBranch, (_e, cwd: string) => getGitBranch(cwd));
	ipcMain.handle(IpcChannels.ProjectListGitBranches, (_e, cwd: string) => listGitBranches(cwd));
	ipcMain.handle(IpcChannels.ProjectCheckoutBranch, (_e, cwd: string, branch: string) =>
		checkoutBranch(cwd, branch),
	);
	ipcMain.handle(IpcChannels.AppOpenExternal, (_e, url: string) => {
		// 只允许 http(s) 链接，防 file:// 等协议滥用
		if (typeof url === "string" && /^https?:\/\//.test(url)) return shell.openExternal(url);
	});
	ipcMain.handle(IpcChannels.TabsLoad, () => loadTabs());
	ipcMain.handle(IpcChannels.TabsSave, (_e, tabs: SavedTabs) => saveTabs(tabs));
	ipcMain.handle(IpcChannels.UiStateLoad, () => loadUiState());
	ipcMain.handle(IpcChannels.UiStateSave, (_e, state: Partial<UiState>) => saveUiState(state));
	ipcMain.handle(IpcChannels.BackgroundPick, () => pickBackgroundImage(BrowserWindow.getAllWindows()[0]));
	ipcMain.handle(IpcChannels.ProjectPickDirectory, async () => {
		const window = BrowserWindow.getAllWindows()[0];
		const options: Electron.OpenDialogOptions = { properties: ["openDirectory", "createDirectory"] };
		const result = window
			? await dialog.showOpenDialog(window, options)
			: await dialog.showOpenDialog(options);
		return result.canceled ? null : result.filePaths[0];
	});
	ipcMain.handle(IpcChannels.ProjectListFiles, (_e, cwd?: string) => backend.listProjectFiles(cwd));

	backend.onEvent((sessionId, event) => {
		sendToRenderer(IpcChannels.Event, { sessionId, event });
	});
	backend.onPermissionRequest((req: PermissionRequest) => {
		sendToRenderer(IpcChannels.PermissionRequest, req);
	});
	backend.onTrustRequest((req: TrustRequest) => {
		sendToRenderer(IpcChannels.TrustRequest, req);
	});
}

app.whenReady().then(async () => {
	initLogging(join(app.getPath("userData"), "logs"));
	log.info("app ready", { version: app.getVersion(), userData: app.getPath("userData") });

	// 自定义背景图协议：pi-bg://background/<文件名> → userData/backgrounds/<文件名>（文件名白名单防路径穿越）
	protocol.handle(BG_PROTOCOL, (request) => {
		const name = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, "");
		if (!/^[\w.-]+$/.test(name)) return new Response("invalid background name", { status: 400 });
		return net.fetch(pathToFileURL(join(backgroundsDir(), name)).toString());
	});

	// renderer 异常/崩溃 → 日志（错误排查依赖 trace + 日志）
	const crashLog = createLogger("renderer");
	app.on("web-contents-created", (_e, contents) => {
		contents.on("render-process-gone", (_event, details) => {
			crashLog.error("render process gone", details);
		});
		contents.on("unresponsive", () => {
			crashLog.warn("renderer unresponsive");
		});
		contents.on("console-message", (_event, level, message, line, sourceId) => {
			// level: 0 verbose / 1 info / 2 warning / 3 error
			if (level >= 3) crashLog.error("renderer console", { message, line, sourceId });
			else crashLog.debug("renderer console", { message, line, sourceId });
		});
	});

	process.on("uncaughtException", (err) => {
		log.error("uncaught exception", err);
	});
	process.on("unhandledRejection", (reason) => {
		log.error("unhandled rejection", reason);
	});

	backend = new PiBackend();
	await backend.init();
	registerIpc();
	const uiState = await loadUiState();
	createWindow(resolveWindowBackground(uiState?.theme));

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow(resolveWindowBackground(uiState?.theme));
	});
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
	backend?.dispose();
});
