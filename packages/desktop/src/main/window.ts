import { join } from "node:path";
import { IpcChannels, type ThemeMode } from "@percho/shared";
import { app, BrowserWindow, nativeTheme, shell } from "electron";

const __dirname = import.meta.dirname;

/** 等「确认窗已上屏」回执的兑底时长：超过它没回执 = 渲染进程卡死/崩溃 */
const QUIT_ACK_TIMEOUT_MS = 1500;

/** 应用是否正在退出（⌘Q / 菜单「退出」/ Dock 右键退出时由 before-quit 置位） */
let quitting = false;

/** 渲染端是否已接管退出确认（App 挂载时经 `app:setQuitGuard` 置位）。
 *  只有托管成功才拦关窗——没人弹窗时拦下来等于窗口关不掉 */
let quitGuard = false;
/** 等「弹窗已上屏」回执的兑底计时（详见 close 分支） */
let quitAckTimer: NodeJS.Timeout | undefined;

/** before-quit 调用：置位后 close 事件不再被拦截（macOS 关窗隐藏态也要能让 ⌘Q 真退出） */
export function markQuitting(): void {
	quitting = true;
	ackQuitDialog();
}

export function setQuitGuard(enabled: boolean): void {
	quitGuard = enabled;
}

/** 渲染端回执「确认窗已上屏」→ 撤掉兑底计时，交回给用户决定 */
export function ackQuitDialog(): void {
	if (!quitAckTimer) return;
	clearTimeout(quitAckTimer);
	quitAckTimer = undefined;
}

/** 窗口启动底色跟随主题，避免深色模式下启动白闪（也是开屏动画的底色）。与 renderer bg-canvas 同色 */
function windowBackground(theme: "dark" | "light"): string {
	return theme === "dark" ? "#17171a" : "#fafafa";
}

/** 解析保存的主题为明确的深浅色（system 时跟随系统），窗口底色与 ?theme= 传参同源 */
export function resolveTheme(theme: ThemeMode | undefined): "dark" | "light" {
	return theme === "dark" || (theme !== "light" && nativeTheme.shouldUseDarkColors) ? "dark" : "light";
}

/**
 * Windows frameless 窗口右上角的系统按钮（最小化/最大化/关闭）覆盖层参数。
 * 颜色与顶栏 bg-canvas 一致保证无色差；height 与顶栏 h-12（48px）对齐让按钮垂直居中。
 */
function titleBarOverlay(theme: "dark" | "light"): Electron.TitleBarOverlay {
	return {
		color: windowBackground(theme),
		symbolColor: theme === "dark" ? "#fafafa" : "#17171a",
		height: 48,
	};
}

/** 主题切换后同步窗口底色与 Windows 窗口按钮覆盖层（macOS 红绿灯由系统绘制，无需处理） */
export function applyChromeTheme(mode: ThemeMode): void {
	const resolved = resolveTheme(mode);
	for (const win of BrowserWindow.getAllWindows()) {
		win.setBackgroundColor(windowBackground(resolved));
		if (process.platform === "win32") win.setTitleBarOverlay(titleBarOverlay(resolved));
	}
}

export function createWindow(theme: "dark" | "light" = "light"): BrowserWindow {
	const window = new BrowserWindow({
		width: 1100,
		height: 750,
		minWidth: 640,
		minHeight: 480,
		show: false,
		// macOS：hiddenInset 红绿灯嵌入顶栏；Windows：frameless + 右上角系统按钮覆盖层；
		// Linux 不支持覆盖层，保留原生框架（不指定 titleBarStyle）
		...(process.platform === "darwin"
			? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 16, y: 16 } }
			: {}),
		...(process.platform === "win32"
			? { titleBarStyle: "hidden" as const, titleBarOverlay: titleBarOverlay(theme) }
			: {}),
		backgroundColor: windowBackground(theme),
		webPreferences: {
			preload: join(__dirname, "../preload/index.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			// 页面不可见（最小化/锁屏/屏保）时不节流 setTimeout 等 timer：
			// agent 后台跑任务时的提醒计时（voice-alerts 安静窗口）不能被 Chromium 后台节流推迟到每分钟一次
			backgroundThrottling: false,
		},
	});

	window.on("ready-to-show", () => window.show());

	// 新文档开始加载（重载/HMR）→ 旧 guard 失效，等 renderer 重新挂载后再接管
	window.webContents.on("did-start-loading", () => {
		quitGuard = false;
	});

	// 关窗语义按平台：
	// - macOS：红点/⌘W = 收起窗口（应用继续跑，Dock/菜单栏可恢复）
	// - Windows：✕ 就是退出（微软惯例），保留；只在渲染端接管了确认弹窗时拦一手，
	//   让用户看到「退出后正在跑的任务会终止」再决定
	// - Linux：关窗即退，行为不变
	window.on("close", (event) => {
		if (quitting) return;
		if (process.platform === "darwin") {
			event.preventDefault();
			window.hide();
			return;
		}
		if (process.platform !== "win32") return;
		if (!quitGuard || window.webContents.isDestroyed()) return;
		event.preventDefault();
		window.webContents.send(IpcChannels.QuitRequested);
		// 兑底：渲染端弹窗上屏后会回执 `app:quitDialogShown`；超时没回执就说明渲染进程
		// 卡死/崩溃（实测 unresponsive 事件此时不一定来），弹窗永远不会出现——
		// 那就放行退出，退回「关窗即退」的原行为。关不掉的窗口比误点退出更糟
		ackQuitDialog();
		quitAckTimer = setTimeout(() => {
			quitAckTimer = undefined;
			quitting = true;
			app.quit();
		}, QUIT_ACK_TIMEOUT_MS);
	});

	// 聊天中的相对链接不能导航主窗口：否则按 app.asar/out/renderer/ 解析，找不到即白屏。
	// will-navigate 仅针对页面发起的导航，不拦启动时的 loadURL/loadFile。
	window.webContents.on("will-navigate", (event) => event.preventDefault());
	window.webContents.setWindowOpenHandler((details) => {
		// 新窗口也不交给 Electron 内嵌打开；仅安全的网页协议交给系统浏览器。
		if (/^https?:\/\//i.test(details.url)) void shell.openExternal(details.url);
		return { action: "deny" };
	});

	// 已解析主题经 query 传给 renderer（bootstrap-theme.ts 首帧前写入 data-theme）
	if (process.env.ELECTRON_RENDERER_URL) {
		const url = new URL(process.env.ELECTRON_RENDERER_URL);
		url.searchParams.set("theme", theme);
		void window.loadURL(url.toString());
	} else {
		void window.loadFile(join(__dirname, "../renderer/index.html"), { search: `theme=${theme}` });
	}

	return window;
}
