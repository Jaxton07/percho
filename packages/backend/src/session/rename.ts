import { existsSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";

/**
 * 历史会话改名：离线打开会话文件追加一条 `session_info`（与 pi CLI `/name` 同源机制）。
 * 不建会话、不注册扩展、零会话开销；因为没有活跃 session，**不会**发 `session_info_changed`
 * → 调用方（渲染端）需自己更新该条标题。
 */
export function renameSessionFile(sessionFile: string, name: string): void {
	// 文件被外部删掉时不能静默成功：SDK 对无 assistant 消息的新会话本就不落盘，
	// 直接 open+append 会悄悄丢弃这次改名（界面已显示新名字但磁盘没有）
	if (!existsSync(sessionFile)) throw new Error(`Session file not found: ${sessionFile}`);
	SessionManager.open(sessionFile).appendSessionInfo(name);
}
