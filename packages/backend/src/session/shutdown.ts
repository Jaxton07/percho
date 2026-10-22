import type { AgentSession } from "@earendil-works/pi-coding-agent";

/**
 * SDK 1.4 的 dispose() 仍不派发 session_shutdown；MCP 等扩展靠该事件释放资源。
 * 调用方必须先等待本函数，再 dispose：dispose 会 invalidate runner，使扩展 ctx 失效。
 * 通过公开 extensionRunner 派发，避免依赖 SDK 内部 runtime 的关闭入口。
 * 应用退出时的同步兜底与普通关闭的等待策略由各自调用方负责。
 */
export function emitSessionShutdown(session: AgentSession): Promise<void> {
	// 尽力而为：本函数对调用方的契约是「要嘛一个 Promise（可能 reject），不要同步抛」。
	// 真实会话的 extensionRunner 是必存在的 getter，但测试里的 AgentSession 替身往往不含它，
	// 直接调会同步抛 TypeError —— 而调用方的 `.catch()` 对同步异常无效，会连带把后面的
	// `session.dispose()` 一起跳过（那正好是本修复要防的「漏掉清理」）。
	try {
		return Promise.resolve(session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }));
	} catch (error) {
		return Promise.reject(error instanceof Error ? error : new Error(String(error)));
	}
}
