import "./pi-package-dir";
import "./dev-agent-dir";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createLogger, initLogging, PiBackend } from "@percho/backend";
import type { ThemeMode } from "@percho/shared";
import { app, BrowserWindow, nativeTheme, net, protocol } from "electron";
import { backgroundsDir } from "./background";
import { registerIpc } from "./ipc";
import { loadUiState } from "./ui-state";
import { initUpdater, scheduleAutoUpdateCheck } from "./updater";
import { createWindow } from "./window";

const log = createLogger("main");
let backend: PiBackend;

/** renderer 加载自定义背景图的协议（pi-bg://background/<文件名>，只读 userData/backgrounds/） */
const BG_PROTOCOL = "pi-bg";

protocol.registerSchemesAsPrivileged([
	{ scheme: BG_PROTOCOL, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

/** 解析保存的主题为明确的深浅色（system 时跟随系统），窗口底色与 ?theme= 传参同源 */
function resolveTheme(theme: ThemeMode | undefined): "dark" | "light" {
	const dark = theme === "dark" || (theme !== "light" && nativeTheme.shouldUseDarkColors);
	return dark ? "dark" : "light";
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
		contents.on("console-message", (details) => {
			// details.level: debug / info / warning / error（Electron 37+ 对象形式，旧数值签名已废弃）
			const { level, message, lineNumber, sourceId } = details;
			if (level === "error") crashLog.error("renderer console", { message, line: lineNumber, sourceId });
			else crashLog.debug("renderer console", { message, line: lineNumber, sourceId });
		});
	});

	process.on("uncaughtException", (err) => {
		log.error("uncaught exception", err);
	});
	process.on("unhandledRejection", (reason) => {
		log.error("unhandled rejection", reason);
	});

	backend = new PiBackend({ visionConfigPath: join(app.getPath("userData"), "vision.json") });
	await backend.init();
	registerIpc(backend);
	await initUpdater();
	scheduleAutoUpdateCheck();
	const uiState = await loadUiState();
	createWindow(resolveTheme(uiState?.theme));

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow(resolveTheme(uiState?.theme));
	});
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
	backend?.dispose();
});
