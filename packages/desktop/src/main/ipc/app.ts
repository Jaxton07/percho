import { writeFile } from "node:fs/promises";
import type { PiBackend } from "@percho/backend";
import type { SavedTabs, UiState } from "@percho/shared";
import { IpcChannels } from "@percho/shared";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { pickBackgroundImage } from "../background";
import { checkoutBranch, getGitBranch, listGitBranches } from "../git";
import { loadTabs, saveTabs } from "../tabs";
import { loadUiState, saveUiState } from "../ui-state";
import { checkForUpdates, installUpdate } from "../updater";

/** 项目仓库地址（帮助跳转 + 关于页） */
const REPO_URL = "https://github.com/Jaxton07/percho";

/**
 * 应用域：窗口级功能（不依赖 PiBackend 会话状态的部分也在此，backend 参数仅为对齐签名）。
 * tabs/ui-state 持久化、背景图、更新、文件/目录对话框、git 分支、外链与应用信息。
 */
export function registerAppIpc(_backend: PiBackend): void {
	ipcMain.handle(IpcChannels.AppOpenExternal, (_e, url: string) => {
		// 只允许 http(s) 链接，防 file:// 等协议滥用
		if (typeof url === "string" && /^https?:\/\//.test(url)) return shell.openExternal(url);
	});
	ipcMain.handle(IpcChannels.AppGetInfo, () => ({
		name: app.getName(),
		version: app.getVersion(),
		electron: process.versions.electron ?? "",
		chrome: process.versions.chrome ?? "",
		node: process.versions.node ?? "",
		platform: process.platform,
		arch: process.arch,
		repoUrl: REPO_URL,
	}));
	ipcMain.handle(IpcChannels.TabsLoad, () => loadTabs());
	ipcMain.handle(IpcChannels.TabsSave, (_e, tabs: SavedTabs) => saveTabs(tabs));
	ipcMain.handle(IpcChannels.UiStateLoad, () => loadUiState());
	ipcMain.handle(IpcChannels.UiStateSave, (_e, state: Partial<UiState>) => saveUiState(state));
	ipcMain.handle(IpcChannels.BackgroundPick, () => pickBackgroundImage(BrowserWindow.getAllWindows()[0]));
	ipcMain.handle(IpcChannels.UpdateCheck, () => checkForUpdates());
	ipcMain.handle(IpcChannels.UpdateInstall, () => installUpdate());
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
	ipcMain.handle(IpcChannels.ProjectPickDirectory, async () => {
		const window = BrowserWindow.getAllWindows()[0];
		const options: Electron.OpenDialogOptions = { properties: ["openDirectory", "createDirectory"] };
		const result = window
			? await dialog.showOpenDialog(window, options)
			: await dialog.showOpenDialog(options);
		return result.canceled ? null : result.filePaths[0];
	});
	ipcMain.handle(IpcChannels.ProjectGetGitBranch, (_e, cwd: string) => getGitBranch(cwd));
	ipcMain.handle(IpcChannels.ProjectListGitBranches, (_e, cwd: string) => listGitBranches(cwd));
	ipcMain.handle(IpcChannels.ProjectCheckoutBranch, (_e, cwd: string, branch: string) =>
		checkoutBranch(cwd, branch),
	);
}
