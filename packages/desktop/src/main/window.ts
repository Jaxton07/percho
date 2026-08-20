import { join } from "node:path";
import type { ThemeMode } from "@percho/shared";
import { BrowserWindow, nativeTheme, shell } from "electron";

const __dirname = import.meta.dirname;

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
		},
	});

	window.on("ready-to-show", () => window.show());

	window.webContents.setWindowOpenHandler((details) => {
		void shell.openExternal(details.url);
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
