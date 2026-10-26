import { join } from "node:path";
import type { LocalStorageRecord } from "@percho/backend";
import { IpcChannels, STORAGE_STARTUP_CHANNELS } from "@percho/shared";
import { app, BrowserWindow, ipcMain } from "electron";
import type { LocalStorageSelection } from "../../../backend/src/storage/path-policy";
import { localStorageSelection, localStorageSelectionError } from "./dev-agent-dir";
import { StorageStartupController } from "./storage-startup-controller";

export function prepareLocalStorage(): Promise<{
	record: LocalStorageRecord;
	selection: LocalStorageSelection;
	close: () => void;
}> {
	const window = new BrowserWindow({
		width: 680,
		height: 520,
		show: false,
		title: "Percho",
		backgroundColor: "#fafafa",
		webPreferences: {
			preload: join(import.meta.dirname, "../preload/index.cjs"),
			contextIsolation: true,
			sandbox: true,
			nodeIntegration: false,
		},
	});
	window.once("ready-to-show", () => window.show());
	return new Promise((resolve) => {
		const controller = new StorageStartupController({
			selection: localStorageSelection,
			error: localStorageSelectionError,
			userData: app.getPath("userData"),
			onChange: (state) => {
				if (!window.isDestroyed()) window.webContents.send(IpcChannels.StorageStartup, state);
			},
			onExit: () => {
				// destroy bypasses the close guard; calling quit first would re-enter it.
				if (!window.isDestroyed()) window.destroy();
				// Let an in-progress native close finish before requesting application quit.
				setImmediate(() => app.quit());
			},
			onReady: (record, selection) =>
				resolve({
					record,
					selection,
					close: () => {
						window.destroy();
					},
				}),
		});
		for (const [name, def] of Object.entries(STORAGE_STARTUP_CHANNELS)) {
			ipcMain.handle(def.channel, (event, args: unknown) => {
				if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame)
					throw new Error("Storage preparation belongs to its startup window");
				def.validate(args);
				if (name === "storageStartupGet") return controller.state;
				controller.act((args as { action: Parameters<typeof controller.act>[0] }).action);
			});
		}
		window.on("close", (event) => {
			event.preventDefault();
			controller.act("exit");
		});
		window.once("closed", () => {
			for (const def of Object.values(STORAGE_STARTUP_CHANNELS)) ipcMain.removeHandler(def.channel);
		});
		const query = { "storage-startup": "1" };
		if (process.env.ELECTRON_RENDERER_URL) {
			const url = new URL(process.env.ELECTRON_RENDERER_URL);
			url.searchParams.set("storage-startup", "1");
			void window.loadURL(url.toString());
		} else void window.loadFile(join(import.meta.dirname, "../renderer/index.html"), { query });
		controller.start();
	});
}
