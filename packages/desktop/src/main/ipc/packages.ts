import type { PiBackend } from "@percho/backend";
import type { CatalogPackageType } from "@percho/shared";
import { IpcChannels } from "@percho/shared";
import { ipcMain } from "electron";

/** 社区包域：pi.dev 目录搜索 + 安装/卸载 + 已配置清单 */
export function registerPackagesIpc(backend: PiBackend): void {
	ipcMain.handle(IpcChannels.PackagesSearchCatalog, (_e, query: string, type?: string, page?: number) =>
		backend.packages.searchPackages(query, type as CatalogPackageType | "" | undefined, page),
	);
	ipcMain.handle(IpcChannels.PackagesInstall, (_e, name: string) => backend.packages.installPackage(name));
	ipcMain.handle(IpcChannels.PackagesRemove, (_e, source: string, scope: "user" | "project") =>
		backend.packages.removePackage(source, scope),
	);
	ipcMain.handle(IpcChannels.PackagesListConfigured, () => backend.packages.listConfiguredPackages());
}
