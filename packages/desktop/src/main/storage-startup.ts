import type { LocalStorageRecord } from "@percho/backend";
import { IpcChannels, type Rect, STORAGE_STARTUP_CHANNELS } from "@percho/shared";
import { app, ipcMain } from "electron";
import type { LocalStorageSelection } from "../../../backend/src/storage/path-policy";
import { localStorageSelection, localStorageSelectionError } from "./dev-agent-dir";
import { StorageStartupController } from "./storage-startup-controller";
import { createWindow } from "./window";

export function prepareLocalStorage(
	theme: "light" | "dark",
	bounds: Rect | null,
): Promise<{
	record: LocalStorageRecord;
	selection: LocalStorageSelection;
	launchWorkbench: () => void;
	failWorkbench: (error: unknown) => void;
}> {
	let launched = false;
	let controller: StorageStartupController;
	const window = createWindow(theme, bounds, {
		isPreparing: () => !launched,
		onClose: () => controller.act("exit"),
	});
	return new Promise((resolve) => {
		controller = new StorageStartupController({
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
					launchWorkbench: () => {
						if (window.isDestroyed()) return;
						launched = true;
						controller.launchWorkbench();
					},
					failWorkbench: (error) => controller.failWorkbench(error),
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
		window.once("closed", () => {
			for (const def of Object.values(STORAGE_STARTUP_CHANNELS)) ipcMain.removeHandler(def.channel);
		});
		controller.start();
	});
}
