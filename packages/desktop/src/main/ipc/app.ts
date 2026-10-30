import { writeFile } from "node:fs/promises";
import { type PiBackend, validateProjectDirectory } from "@percho/backend";
import { APP_CHANNELS, environmentEntityRef } from "@percho/shared";
import { app, BrowserWindow, dialog, nativeTheme, shell } from "electron";
import { releaseChannel } from "../app-identity";
import { pickBackgroundImage } from "../background";
import { cancelComposerEditMenu, showComposerEditMenu } from "../composer-edit-menu";
import { ensureDailyDir } from "../daily";
import { loadEnvironmentUiState, saveEnvironmentUiState } from "../environment-ui-state";
import { checkoutBranch, getGitBranch, listGitBranches } from "../git";
import { nativeNotifications } from "../native-notifications";
import { resolveExistingPath } from "../path-target";
import { setTaskNotificationNavigationReady } from "../task-notifications";
import { loadUiState, saveUiState } from "../ui-state";
import {
	buildUpdateDiagnosticReport,
	checkForUpdates,
	downloadUpdate,
	getUpdateDiagnostics,
	installUpdate,
} from "../updater";
import { ackQuitDialog, setQuitGuard } from "../window";
import { registerInvokeHandlers } from "./invoke";

/** 项目仓库地址（帮助跳转 + 关于页） */
const REPO_URL = "https://github.com/Jaxton07/percho";

/** Native file actions must never interpret a remote UI reference as a local path. */
function localDirectory(cwd: string | null): string | null {
	if (cwd === null) return null;
	const reference = environmentEntityRef(cwd);
	if (reference.environment.kind !== "local") throw new Error("Remote paths cannot be opened by the desktop");
	return reference.id;
}

/**
 * 应用域：窗口级功能（不依赖 PiBackend 会话状态的部分也在此，backend 参数仅为对齐签名）。
 * tabs/ui-state 持久化、背景图、更新、文件/目录对话框、git 分支、外链与应用信息。
 */
export function registerAppIpc(_backend: PiBackend): void {
	registerInvokeHandlers(APP_CHANNELS, {
		setTaskNotificationNavigationReady,
		setNotificationLanguage: ({ language }) => nativeNotifications.setLanguage(language),
		testTaskNotification: () => nativeNotifications.send("test"),
		showComposerEditMenu,
		cancelComposerEditMenu,
		loadEnvironmentUiState,
		saveEnvironmentUiState: ({ state }) => saveEnvironmentUiState(state),
		validateProjectDirectory: ({ path }) => validateProjectDirectory(path),
		saveFileDialog: async ({ defaultName, content }) => {
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
		},
		pickDirectory: async () => {
			const window = BrowserWindow.getAllWindows()[0];
			const options: Electron.OpenDialogOptions = { properties: ["openDirectory", "createDirectory"] };
			const result = window
				? await dialog.showOpenDialog(window, options)
				: await dialog.showOpenDialog(options);
			return result.canceled ? null : (result.filePaths[0] ?? null);
		},
		getGitBranch: ({ cwd }) => getGitBranch(cwd),
		listGitBranches: ({ cwd }) => listGitBranches(cwd),
		checkoutBranch: ({ cwd, branch }) => checkoutBranch(cwd, branch),
		openExternal: ({ url }) => {
			// 只允许 http(s) 链接，防 file:// 等协议滥用
			if (typeof url === "string" && /^https?:\/\//.test(url)) return shell.openExternal(url);
		},
		// 三个路径动作共用一套解析（相对/~/file:// 锚点归一，不存在直接抛错 → toast 显示原因）
		resolvePath: ({ target, cwd }) => resolveExistingPath(target, cwd),
		openPath: async ({ target, cwd }) => {
			const error = await shell.openPath(resolveExistingPath(target, localDirectory(cwd)));
			if (error) throw new Error(error);
		},
		revealPath: ({ target, cwd }) => {
			shell.showItemInFolder(resolveExistingPath(target, localDirectory(cwd)));
		},
		getAppInfo: (): import("@percho/shared").AppInfo => ({
			name: app.getName(),
			releaseChannel,
			version: app.getVersion(),
			electron: process.versions.electron ?? "",
			chrome: process.versions.chrome ?? "",
			node: process.versions.node ?? "",
			platform: process.platform,
			arch: process.arch,
			repoUrl: REPO_URL,
		}),
		// 日常空间目录下发（懒创建；会话创建由 renderer 走新会话页 → promotion 流程）
		getDailyDir: () => ensureDailyDir(),
		loadUiState: () => loadUiState(),
		saveUiState: ({ state }) => {
			if (typeof state.taskNotificationsEnabled === "boolean")
				nativeNotifications.setEnabled(state.taskNotificationsEnabled);
			// 主题变更 → 对齐 main 原生主题（themeSource 赋值触发 updated 事件，窗口底色/Windows 按钮覆盖层随之刷新）
			if (state.theme) nativeTheme.themeSource = state.theme;
			return saveUiState(state);
		},
		pickBackgroundImage: () => pickBackgroundImage(BrowserWindow.getAllWindows()[0]),
		checkForUpdates: () => checkForUpdates(),
		downloadUpdate: () => downloadUpdate(),
		installUpdate: () => installUpdate(),
		getUpdateDiagnostics: () => getUpdateDiagnostics(),
		exportUpdateDiagnostics: async () => {
			const window = BrowserWindow.getAllWindows()[0];
			const options: Electron.SaveDialogOptions = {
				defaultPath: `percho-update-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
				filters: [{ name: "JSON", extensions: ["json"] }],
			};
			const result = window
				? await dialog.showSaveDialog(window, options)
				: await dialog.showSaveDialog(options);
			if (result.canceled || !result.filePath) return null;
			await writeFile(result.filePath, JSON.stringify(await buildUpdateDiagnosticReport(), null, 2), "utf8");
			return result.filePath;
		},
		// 退出确认（Windows）：渲染端挂载后接管 guard，点 ✕ 才会被拦下弹窗
		setQuitGuard: ({ enabled }) => setQuitGuard(enabled),
		quitDialogShown: () => ackQuitDialog(),
		confirmQuit: () => {
			// 与 ⌘Q 同一条路：app.quit() 触发 before-quit → markQuitting() → close 不再被拦
			app.quit();
		},
	});
}
