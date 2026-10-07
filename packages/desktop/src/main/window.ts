import { join } from "node:path";
import { IpcChannels, type Rect, type ThemeMode } from "@percho/shared";
import { app, BrowserWindow, nativeTheme, shell } from "electron";
import { saveUiState, saveUiStateSync } from "./ui-state";
import {
	BOUNDS_SAVE_DEBOUNCE_MS,
	WINDOW_DEFAULT_HEIGHT,
	WINDOW_DEFAULT_WIDTH,
	WINDOW_MIN_HEIGHT,
	WINDOW_MIN_WIDTH,
} from "./window-bounds";

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

/* ---------------- 窗口位置/尺寸持久化（spec layout-freedom §5.1/§5.2） ---------------- */

/** 防抖计时：拖动/缩放途中 resize+move 连绵不断，不能每帧写盘 */
let boundsTimer: NodeJS.Timeout | undefined;
/** 最后一次动过的窗口（退出兕底用；多窗口场景取最后一个即可，本应用实际只会开一个） */
let boundsWindow: BrowserWindow | null = null;

/** 真正落盘：**必须 `getNormalBounds()`** —— `getBounds()` 在最大化/全屏时返回的是最大化尺寸，
 *  写进文件后下次启动会还愿成「超出屏幕的普通窗口」（spec §8 事实 1） */
function persistBounds(window: BrowserWindow | null): void {
	if (!window || window.isDestroyed()) return;
	void saveUiState({ windowBounds: window.getNormalBounds() }).catch(() => {
		/* saveUiState 已记日志（UiStateSave 是 handle 调用），这里只是不把 rejection 抛到 unhandled */
	});
}

/** 防抖调度：多次变化只写最后一次 */
function scheduleBoundsPersist(window: BrowserWindow): void {
	boundsWindow = window;
	if (boundsTimer) clearTimeout(boundsTimer);
	boundsTimer = setTimeout(() => {
		boundsTimer = undefined;
		persistBounds(boundsWindow);
	}, BOUNDS_SAVE_DEBOUNCE_MS);
}

/**
 * 退出兜底：清掉待写的计时器并**同步**写一次。
 * 为什么必须有：防抖窗口内直接退出（Windows 点 ✕ = `app.quit()`）时异步写可能来不及落盘；
 * `updateSync` 不走异步写盘队列（spec §8 事实 5），能在 `close` 回调里真写完。
 */
function flushBounds(): void {
	if (!boundsTimer) return;
	clearTimeout(boundsTimer);
	boundsTimer = undefined;
	const window = boundsWindow;
	if (!window || window.isDestroyed()) return;
	saveUiStateSync({ windowBounds: window.getNormalBounds() });
}

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

export function createWindow(theme: "dark" | "light" = "light", bounds: Rect | null = null): BrowserWindow {
	const window = new BrowserWindow({
		// 有持久化 bounds 就用它（已过 `sanitizeWindowBounds` 屏幕校验），否则走默认尺寸 + 系统摆放
		...(bounds
			? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
			: { width: WINDOW_DEFAULT_WIDTH, height: WINDOW_DEFAULT_HEIGHT }),
		minWidth: WINDOW_MIN_WIDTH,
		minHeight: WINDOW_MIN_HEIGHT,
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

	window.on("ready-to-show", () => {
		window.show();
		// macOS 首次 show() 会把窗口 x 抬到 ≥221 DIP（≈15% 屏宽，详见 docs/PITFALLS.md 与 IMPL-NOTES X1）——
		// 传参没错，是系统的窗口位置约束。**已显示的窗口 setBounds 不受此限**，所以显示后校准一次。
		// show() 与本句同一 tick 完成（中间没有渲染机会），不会看到「先从 221 跳到目标位」（实测见 IMPL-NOTES）。
		if (bounds && (window.getBounds().x !== bounds.x || window.getBounds().y !== bounds.y)) {
			window.setBounds(bounds);
		}
	});

	// 位置/尺寸记忆：拖动、缩放都走这两条事件（**不要**依赖 `resized`/`moved` —— 实测 macOS 上
	// `window.resizeTo` 只来 `resize`，`resized`/`moved` 一次都不来，见 IMPL-NOTES 阶段 1）
	window.on("resize", () => scheduleBoundsPersist(window));
	window.on("move", () => scheduleBoundsPersist(window));

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
		// 先兜底把待写的 bounds 同步落盘（无论哪个平台、无论下面拦不拦关窗），
		// 拦下来（macOS 隐藏 / Windows 等确认弹窗）也不影响：写的是当前真实 bounds
		flushBounds();
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
