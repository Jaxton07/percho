import { execFile } from "node:child_process";
import { PiBackend } from "@pi-desktop/backend";
import {
	type CustomProviderInput,
	IpcChannels,
	type PermissionAnswer,
	type PermissionRequest,
} from "@pi-desktop/shared";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { createWindow } from "./window";

function getGitBranch(cwd: string): Promise<string | null> {
	return new Promise((resolve) => {
		execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeout: 3000 }, (error, stdout) => {
			if (error) resolve(null);
			else resolve(stdout.trim() || null);
		});
	});
}

function listGitBranches(cwd: string): Promise<{ current: string | null; branches: string[] }> {
	return new Promise((resolve) => {
		execFile(
			"git",
			["for-each-ref", "--format=%(refname:short)", "refs/heads/"],
			{ cwd, timeout: 5000 },
			async (error, stdout) => {
				if (error) {
					resolve({ current: null, branches: [] });
					return;
				}
				const branches = stdout
					.split("\n")
					.map((b) => b.trim())
					.filter(Boolean);
				resolve({ current: await getGitBranch(cwd), branches });
			},
		);
	});
}

function checkoutBranch(cwd: string, branch: string): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("git", ["checkout", branch], { cwd, timeout: 15000 }, async (error, _stdout, stderr) => {
			if (error) {
				reject(new Error(stderr?.trim() || error.message));
				return;
			}
			resolve((await getGitBranch(cwd)) ?? branch);
		});
	});
}

let backend: PiBackend;

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
	ipcMain.handle(IpcChannels.SessionPrompt, (_e, sessionId: string, text: string) =>
		backend.prompt(sessionId, text),
	);
	ipcMain.handle(IpcChannels.SessionAbort, (_e, sessionId: string) => backend.abort(sessionId));
	ipcMain.handle(IpcChannels.SessionSetModel, (_e, sessionId: string, provider: string, modelId: string) =>
		backend.setModel(sessionId, provider, modelId),
	);
	ipcMain.handle(IpcChannels.SessionSetThinkingLevel, (_e, sessionId: string, level: string) =>
		backend.setThinkingLevel(sessionId, level),
	);
	ipcMain.handle(IpcChannels.SessionCompact, (_e, sessionId: string) => backend.compact(sessionId));
	ipcMain.handle(IpcChannels.SessionStats, (_e, sessionId: string) => backend.getStats(sessionId));
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
	ipcMain.handle(IpcChannels.ProjectGetGitBranch, (_e, cwd: string) => getGitBranch(cwd));
	ipcMain.handle(IpcChannels.ProjectListGitBranches, (_e, cwd: string) => listGitBranches(cwd));
	ipcMain.handle(IpcChannels.ProjectCheckoutBranch, (_e, cwd: string, branch: string) =>
		checkoutBranch(cwd, branch),
	);
	ipcMain.handle(IpcChannels.AppOpenExternal, (_e, url: string) => {
		// 只允许 http(s) 链接，防 file:// 等协议滥用
		if (typeof url === "string" && /^https?:\/\//.test(url)) return shell.openExternal(url);
	});
	ipcMain.handle(IpcChannels.ProjectPickDirectory, async () => {
		const window = BrowserWindow.getAllWindows()[0];
		const options: Electron.OpenDialogOptions = { properties: ["openDirectory", "createDirectory"] };
		const result = window
			? await dialog.showOpenDialog(window, options)
			: await dialog.showOpenDialog(options);
		return result.canceled ? null : result.filePaths[0];
	});

	backend.onEvent((sessionId, event) => {
		sendToRenderer(IpcChannels.Event, { sessionId, event });
	});
	backend.onPermissionRequest((req: PermissionRequest) => {
		sendToRenderer(IpcChannels.PermissionRequest, req);
	});
}

app.whenReady().then(async () => {
	backend = new PiBackend();
	await backend.init();
	registerIpc();
	createWindow();

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
	backend?.dispose();
});
