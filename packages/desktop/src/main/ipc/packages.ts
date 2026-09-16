import type { PiBackend } from "@percho/backend";
import { PACKAGES_CHANNELS } from "@percho/shared";
import { registerInvokeHandlers } from "./invoke";

/** 社区包域：pi.dev 目录搜索 + 安装/卸载 + 已配置清单 */
export function registerPackagesIpc(backend: PiBackend): void {
	registerInvokeHandlers(PACKAGES_CHANNELS, {
		searchCatalog: ({ query, type, page }) => backend.packages.searchPackages(query, type, page),
		installPackage: ({ name }) => backend.packages.installPackage(name),
		removePackage: ({ source, scope }) => backend.packages.removePackage(source, scope),
		listConfiguredPackages: () => backend.packages.listConfiguredPackages(),
	});
}
