import { join } from "node:path";
import { BrowserWindow, shell } from "electron";

const __dirname = import.meta.dirname;

export function createWindow(): BrowserWindow {
	const window = new BrowserWindow({
		width: 1100,
		height: 750,
		minWidth: 640,
		minHeight: 480,
		show: false,
		titleBarStyle: "hiddenInset",
		trafficLightPosition: { x: 16, y: 16 },
		backgroundColor: "#fafafa",
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

	if (process.env.ELECTRON_RENDERER_URL) {
		void window.loadURL(process.env.ELECTRON_RENDERER_URL);
	} else {
		void window.loadFile(join(__dirname, "../renderer/index.html"));
	}

	return window;
}
