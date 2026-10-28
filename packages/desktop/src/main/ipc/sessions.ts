import { createExecutionHandlers, type PiBackend } from "@percho/backend";
import { SESSION_CHANNELS } from "@percho/shared";
import { registerInvokeHandlers } from "./invoke";

/** 会话域：Session* 通道（生命周期/提示/导出/fork/撤回）+ 模型列表 + 项目文件/信任 */
export function registerSessionsIpc(backend: PiBackend): void {
	// 已表化通道（shared/ipc-channels.ts SESSION_CHANNELS）：handler 与通道定义同源校验
	registerInvokeHandlers(SESSION_CHANNELS, createExecutionHandlers(backend));
}
