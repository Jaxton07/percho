import { createRequire } from "node:module";
import { createLogger } from "@pi-desktop/backend";
import type { UpdateState } from "@pi-desktop/shared";
import { app } from "electron";

const log = createLogger("updater");

// electron-updater 是 CJS 且 autoUpdater 用 Object.defineProperty 导出，ESM named import 会报
// "Named export 'autoUpdater' not found" → createRequire 取（打包态 app-update.yml 由 electron-builder 生成）。
const require = createRequire(import.meta.url);
const { autoUpdater } = require("electron-updater") as typeof import("electron-updater");

type Listener = (state: UpdateState) => void;

const listeners = new Set<Listener>();
/** 最近一次检查到的新版本（download-progress 事件不带版本号） */
let latestVersion: string | null = null;

export function onUpdateState(cb: Listener): void {
	listeners.add(cb);
}

function emit(state: UpdateState): void {
	for (const cb of listeners) cb(state);
}

/** 初始化 autoUpdater 事件转发；dev 模式（未打包）无 app-update.yml，直接跳过 */
export function initUpdater(): void {
	if (!app.isPackaged) return;
	autoUpdater.autoDownload = true;
	autoUpdater.autoInstallOnAppQuit = true;

	autoUpdater.on("checking-for-update", () => emit({ phase: "checking" }));
	autoUpdater.on("update-available", (info) => {
		latestVersion = info.version;
		emit({ phase: "available", version: info.version });
	});
	autoUpdater.on("update-not-available", () => emit({ phase: "not-available" }));
	autoUpdater.on("download-progress", (progress) => {
		if (latestVersion) {
			emit({ phase: "downloading", version: latestVersion, percent: Math.round(progress.percent) });
		}
	});
	autoUpdater.on("update-downloaded", (info) => emit({ phase: "downloaded", version: info.version }));
	autoUpdater.on("error", (error) => {
		log.error("update error", error);
		emit({ phase: "error", message: error instanceof Error ? error.message : String(error) });
	});
}

/** 检查更新（自动/手动同路径：状态经 onUpdateState 上报，错误在 AboutPanel 展示） */
export async function checkForUpdates(): Promise<void> {
	if (!app.isPackaged) return;
	try {
		// autoDownload=true 时发现新版自动开始后台下载，无需手动触发
		await autoUpdater.checkForUpdates();
	} catch (error) {
		log.error("check update failed", error);
	}
}

/** 重启并安装（mac 上 Squirrel 在退出后 stage，重启生效） */
export function installUpdate(): void {
	if (app.isPackaged) autoUpdater.quitAndInstall();
}

/** 启动后延迟静默检查一次，之后每 2 小时一次（latest-mac.yml 仅几 KB，请求极轻） */
export function scheduleAutoUpdateCheck(): void {
	if (!app.isPackaged) return;
	setTimeout(() => {
		void checkForUpdates();
	}, 10_000);
	setInterval(
		() => {
			void checkForUpdates();
		},
		2 * 60 * 60 * 1000,
	);
}
