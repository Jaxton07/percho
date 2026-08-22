import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { createLogger } from "@percho/backend";
import type { UpdateState } from "@percho/shared";
import { app } from "electron";
import { nextUpdateAction } from "./update-policy";

const log = createLogger("updater");

// electron-updater 是 CJS 且 autoUpdater 用 Object.defineProperty 导出，ESM named import 会报
// "Named export 'autoUpdater' not found" → createRequire 取（打包态 app-update.yml 由 electron-builder 生成）。
const require = createRequire(import.meta.url);
const { autoUpdater } = require("electron-updater") as typeof import("electron-updater");

type Listener = (state: UpdateState) => void;

const listeners = new Set<Listener>();
/** 最近一次检查到的新版本（download-progress 事件不带版本号） */
let latestVersion: string | null = null;
/** 已下载待安装：后续静默检查的中间态不再覆盖 UI，安装失败也不回退 */
let downloaded = false;
/** 已上报的 phase：下载中/已下载时屏蔽 checking/not-available，防按钮闪烁/消失 */
let currentPhase: UpdateState["phase"] | null = null;
/** 当前构建无法自动安装（mac adhoc/未签名）→ 更新只提示，点击跳 release 页手动下载 */
let manualInstall = false;

/**
 * mac 上 Squirrel 安装前强制校验代码签名（旧 app 的 designated requirement），
 * adhoc/未签名构建必失败且静默无反应 → 检测出来走手动下载流程；正式签名后自动恢复正常路径
 */
function detectManualInstall(): Promise<boolean> {
	if (process.platform !== "darwin") return Promise.resolve(false);
	const exe = app.getPath("exe");
	const appIndex = exe.indexOf(".app/");
	if (appIndex === -1) return Promise.resolve(true);
	const bundlePath = exe.slice(0, appIndex + ".app".length);
	return new Promise((resolve) => {
		// codesign -dv 的信息输出在 stderr；命令失败（含完全未签名）也按手动安装处理
		// 3s 超时兜底：codesign 卡死（如钥匙串不可用）时走 error 分支回退 manual
		execFile(
			"codesign",
			["-dv", bundlePath],
			{ timeout: 3000 },
			(error, _stdout, stderr) => {
				if (error) {
					log.warn("codesign check failed, fallback to manual install", error.message);
					resolve(true);
					return;
				}
				resolve(stderr.includes("Signature=adhoc"));
			},
		);
	});
}

export function onUpdateState(cb: Listener): void {
	listeners.add(cb);
}

function emit(state: UpdateState): void {
	if (currentPhase === "downloading" || currentPhase === "downloaded") {
		if (state.phase === "checking" || state.phase === "not-available") return;
		if (state.phase === "available" && currentPhase === "downloaded") return;
	}
	currentPhase = state.phase;
	for (const cb of listeners) cb(state);
}

/** 初始化 autoUpdater 事件转发；dev 模式（未打包）无 app-update.yml，直接跳过 */
export async function initUpdater(): Promise<void> {
	if (!app.isPackaged) return;
	manualInstall = await detectManualInstall();
	if (manualInstall) {
		log.info("unsigned/adhoc build: auto-install disabled, update clicks open the release page");
	}
	// 不做后台自动下载：发现新版只发 available 提示，用户点击后才下载
	autoUpdater.autoDownload = false;
	// 兜底：若下载完成后安装流程未执行，用户完全退出 app 时自动安装
	autoUpdater.autoInstallOnAppQuit = true;
	// 安装完成后自动重启应用（默认即 true，显式声明依赖此行为）
	autoUpdater.autoRunAppAfterInstall = true;

	autoUpdater.on("checking-for-update", () => emit({ phase: "checking" }));
	autoUpdater.on("update-available", (info) => {
		latestVersion = info.version;
		emit({ phase: "available", version: info.version, manual: manualInstall });
	});
	autoUpdater.on("update-not-available", () => emit({ phase: "not-available" }));
	autoUpdater.on("download-progress", (progress) => {
		if (latestVersion) {
			emit({ phase: "downloading", version: latestVersion, percent: Math.round(progress.percent) });
		}
	});
	autoUpdater.on("update-downloaded", (info) => {
		latestVersion = info.version;
		downloaded = true;
		emit({ phase: "downloaded", version: info.version });
		// 不自动安装：用户可能有运行中任务，点击「重启」胶囊（或完全退出 app 兜底）才安装
	});
	autoUpdater.on("error", (error) => {
		log.error("update error", error);
		if (downloaded) return;
		if (latestVersion) {
			// 下载失败 → 回退到「发现新版本」保留下载入口，用户可重试
			emit({ phase: "available", version: latestVersion, manual: manualInstall });
		} else {
			emit({ phase: "error", message: error instanceof Error ? error.message : String(error) });
		}
	});
}

/**
 * 纯检查更新（定时任务与关于页按钮走这里）：autoDownload=false，发现新版只发 available 提示，
 * **绝不下载**——下载只经 downloadUpdate()（用户显式点击）。
 */
export async function checkForUpdates(): Promise<void> {
	if (!app.isPackaged) return;
	try {
		await autoUpdater.checkForUpdates();
	} catch (error) {
		// 失败经 error 事件上报，这里只兜 unhandled rejection
		log.error("update check failed", error);
	}
}

/**
 * 下载更新（顶栏 UpdateButton 用户点击）：已发现新版未下载且非 manual → 下载；
 * 未发现新版 → 退化为先检查（检查到后用户再点一次下载，语义与按钮状态机一致）。
 */
export async function downloadUpdate(): Promise<void> {
	if (!app.isPackaged) return;
	const action = nextUpdateAction({ latestVersion, downloaded, manualInstall });
	try {
		if (action === "download" && latestVersion) {
			// 立即上报 downloading（download-progress 首个事件可能滞后），按钮马上变进度环
			emit({ phase: "downloading", version: latestVersion, percent: 0 });
			await autoUpdater.downloadUpdate();
		} else {
			await autoUpdater.checkForUpdates();
		}
	} catch (error) {
		// 失败经 error 事件上报（downloadUpdate 内部 dispatchError），这里只兜 unhandled rejection
		log.error("update action failed", error);
	}
}

/** 重启并安装（仅用户点击「重启」胶囊时调用；mac 上 Squirrel 退出后 stage，装完自动重启） */
export function installUpdate(): void {
	if (app.isPackaged) autoUpdater.quitAndInstall();
}

/** 启动后延迟静默检查一次，之后每 2 小时一次（latest-mac.yml 仅几 KB，请求极轻；只检查不下载） */
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
