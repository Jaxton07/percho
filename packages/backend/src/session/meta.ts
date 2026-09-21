import { statSync } from "node:fs";
import type { SessionEntry, SessionHeader } from "@earendil-works/pi-coding-agent";

/**
 * 会话时间字段的**权威口径**（spec sidebar-session-switch-stability D1），
 * 与 SDK `buildSessionInfo()`（`SessionManager.list` 的磁盘枚举）逐条对齐：
 *
 * - `createdAt` = session header 的 timestamp —— **不是**文件时间：复制/恢复/迁移会话文件会改
 *   birthtime（旧实现就是踩在这上面），header 时间才是「会话诞生时刻」；
 * - `modifiedAt` = 所有 `message` entry 里 **role 为 user/assistant** 的最大活动时间；
 *   message 自带数值 `timestamp` 优先，退回 entry 的 ISO `timestamp`；
 *   其它 entry（custom / label / compaction / session_info…）与非 user/assistant 消息（toolResult 等）
 *   一律不算活动 —— 否则 channel cursor 之类的扩展写入会把会话顶到列表最前；
 * - 没有任何这类消息时 `modifiedAt = createdAt`。
 *
 * header 读不出来（空文件/非会话文件/异常）时返回 `null`，由调用方走 `fileTimeFallback` 兜底。
 */
export interface SessionTimes {
	createdAt: number;
	modifiedAt: number;
}

export function deriveSessionTimes(
	header: SessionHeader | null | undefined,
	entries: readonly SessionEntry[],
): SessionTimes | null {
	const createdAt = parseTimestamp(header?.timestamp);
	if (createdAt === undefined) return null;
	let latest: number | undefined;
	for (const entry of entries) {
		const activity = messageActivityTime(entry);
		if (activity === undefined || activity <= 0) continue;
		latest = latest === undefined ? activity : Math.max(latest, activity);
	}
	return { createdAt, modifiedAt: latest ?? createdAt };
}

/** 单条 entry 的会话活动时间：只认 user/assistant 消息，其余一律 undefined */
function messageActivityTime(entry: SessionEntry): number | undefined {
	if (entry.type !== "message") return undefined;
	const message = entry.message as { role?: unknown; timestamp?: unknown } | undefined;
	if (message?.role !== "user" && message?.role !== "assistant") return undefined;
	if (typeof message.timestamp === "number") return message.timestamp;
	return parseTimestamp(entry.timestamp);
}

function parseTimestamp(value: unknown): number | undefined {
	if (typeof value !== "string") return undefined;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * 异常路径兜底（header 读不出来）：文件 mtime → 当前时刻，两个字段用同一基准保证自洽。
 * 刻意不用 birthtime：它随复制/恢复而变，语义上不是「会话创建时间」。
 */
export function fallbackSessionTimes(sessionFile: string | undefined): SessionTimes {
	const time = fileTimeFallback(sessionFile);
	return { createdAt: time, modifiedAt: time };
}

function fileTimeFallback(sessionFile: string | undefined): number {
	if (!sessionFile) return Date.now();
	try {
		return statSync(sessionFile).mtimeMs;
	} catch {
		return Date.now();
	}
}
