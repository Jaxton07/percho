import { join } from "node:path";
import { BrowserWindow, shell } from "electron";

const __dirname = import.meta.dirname;

/** 窗口启动底色跟随主题，避免深色模式下启动白闪（也是开屏动画的底色） */
function windowBackground(theme: "dark" | "light"): string {
	return theme === "dark" ? "#17171a" : "#fafafa";
}

export function createWindow(theme: "dark" | "light" = "light"): BrowserWindow {
	const window = new BrowserWindow({
		width: 1100,
		height: 750,
		minWidth: 640,
		minHeight: 480,
		show: false,
		titleBarStyle: "hiddenInset",
		trafficLightPosition: { x: 16, y: 16 },
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
