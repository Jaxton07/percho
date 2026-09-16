import type { PiBackend } from "@percho/backend";
import { IpcChannels, PACKAGES_CHANNELS } from "@percho/shared";
import { ipcMain } from "electron";
import { registerInvokeHandlers } from "./invoke";

/** 社区包域：pi.dev 目录搜索 + 安装/卸载 + 已配置清单 */
export function registerPackagesIpc(backend: PiBackend): void {
	registerInvokeHandlers(PACKAGES_CHANNELS, {
		searchCatalog: ({ query, type, page }) => backend.packages.searchPackages(query, type, page),
	});
	ipcMain.handle(IpcChannels.PackagesInstall, (_e, name: string) => backend.packages.installPackage(name));
	ipcMain.handle(IpcChannels.PackagesRemove, (_e, source: string, scope: "user" | "project") =>
		backend.packages.removePackage(source, scope),
	);
	ipcMain.handle(IpcChannels.PackagesListConfigured, () => backend.packages.listConfiguredPackages());
}
