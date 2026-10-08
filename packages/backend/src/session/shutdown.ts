import type { AgentSession } from "@earendil-works/pi-coding-agent";

/**
 * 会话终结时把 `session_shutdown` 送给扩展 —— 对齐官方 `AgentSessionRuntime.dispose()`。
 *
 * ❗**必须显式送，不能只调 `session.dispose()`**：SDK 的 `AgentSession.dispose()` 只
 * `invalidate()` 扩展 runner、**不发 `session_shutdown`**（pi 1.0.4 `core/agent-session.js:988`），
 * 而官方内置扩展只在 `session_shutdown` 里释放会话级资源。漏送的直接后果是 **MCP stdio
 * 子进程永久常驻**：关掉会话只减少内存里的 runner，`uvx`/`node` 那棵子树照旧活着、还占着
 * MCP server 的连接（2026-10-08 实测：关掉 3 个会话留下 3 个 `uvx`，只有 app 退出才清）。
 *
 * 官方自己的 `AgentSessionRuntime.dispose()` 就是「先 emit 再 dispose」（`core/agent-session-runtime.js`
 * 里 `await emitSessionShutdownEvent(...)` 后才 `this.session.dispose()`），本函数与之对齐。
 * 那个内部函数没从包根导出（exports map 只开 `.`/`./rpc-entry`/`./client`/`./experimental/plugin`），
 * 所以这里走**公开 API** 等价复现：`session.extensionRunner` 是 public getter，
 * `ExtensionRunner` 从包根导出。
 *
 * **调用方必须在 `session.dispose()` 之前调用**：dispose 会 invalidate runner，之后扩展
 * 拿到的 ctx 全部失效（`assertActive` 抛错）。
 *
 * 影响面（pi 1.0.4 实测）：官方内置扩展里**只有 mcp** 注册了 `session_shutdown`
 * （codemode / tool-search 都没有），Percho 侧只有 channel-watch —— 它的清理幂等，
 * 且本就有 modeRef 路径兜底，重复执行无害。
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
