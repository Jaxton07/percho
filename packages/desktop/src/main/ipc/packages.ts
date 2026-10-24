import { createExecutionHandlers, type PiBackend } from "@percho/backend";
import { PACKAGES_CHANNELS } from "@percho/shared";
import { registerInvokeHandlers } from "./invoke";

/** 社区包域：pi.dev 目录搜索 + 安装/卸载 + 已配置清单 */
export function registerPackagesIpc(backend: PiBackend): void {
	registerInvokeHandlers(PACKAGES_CHANNELS, createExecutionHandlers(backend));
}
