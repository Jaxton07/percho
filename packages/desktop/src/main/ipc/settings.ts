import { createExecutionHandlers, type PiBackend } from "@percho/backend";
import { MCP_CHANNELS, SETTINGS_CHANNELS } from "@percho/shared";
import { registerInvokeHandlers } from "./invoke";

/** 设置域：provider 设置 + 权限门控配置 + 项目信任应答 */
export function registerSettingsIpc(backend: PiBackend): void {
	// MCP 域（spec §5）：官方内置 mcp 扩展的 mcp.json 读写（连接/展开交给官方）
	registerInvokeHandlers(MCP_CHANNELS, createExecutionHandlers(backend));

	registerInvokeHandlers(SETTINGS_CHANNELS, createExecutionHandlers(backend));
}
