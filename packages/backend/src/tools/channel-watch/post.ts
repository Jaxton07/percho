import { appendFile, mkdir } from "node:fs/promises";
import { topicDir } from "./init";

/**
 * channel_post 落盘层（spec channel-post.md）：消息 = 意图，不是 IO。
 *
 * - 消息追加到 `<channelRoot>/<topic>/MESSAGES.md`（只增不删，天然消息日志）
 * - 条目格式：`## YYYY-MM-DD HH:MM · <sessionId 前 8 位>` + 空行 + 正文 + `\n---\n`
 * - closed=true（终态信号）标题行末尾加 ` · [CLOSED]`，订阅方查收后自行退订
 * - 目录不存在自动建（频道可由首条 post 建立）
 * - 纯 fs 操作可单测；trusted 门/guard 标记由 extension.ts 闭包负责
 */

export const MESSAGES_FILE = "MESSAGES.md";

export interface PostInput {
	topic: string;
	message: string;
	closed?: boolean;
	/** 来源会话 id（取前 8 位；undefined 则省略来源段） */
	sessionId?: string;
	/** 时间（测试注入；默认 new Date()） */
	at?: Date;
}

/** 本地时间 `YYYY-MM-DD HH:MM:SS`（精确到秒：同一分钟内多条 post 可区分顺序） */
function formatTimestamp(at: Date): string {
	const p = (n: number): string => String(n).padStart(2, "0");
	return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())} ${p(at.getHours())}:${p(at.getMinutes())}:${p(at.getSeconds())}`;
}

/** 构造单条消息条目（含尾部分隔线；多条 append 自然衔接） */
export function formatPostEntry(input: PostInput): string {
	const at = input.at ?? new Date();
	const source = input.sessionId ? ` · ${input.sessionId.slice(0, 8)}` : "";
	const closed = input.closed ? " · [CLOSED]" : "";
	const body = input.message.replace(/\s+$/, "");
	return `## ${formatTimestamp(at)}${source}${closed}\n\n${body}\n\n---\n`;
}

/**
 * 追加一条消息到频道 MESSAGES.md（mkdir -p 频道目录）。
 * 返回 MESSAGES.md 绝对路径（调用方做 guard.markSelfWrite）。
 */
export async function appendPost(cwd: string, input: PostInput): Promise<string> {
	const dir = topicDir(cwd, input.topic);
	await mkdir(dir, { recursive: true });
	const file = `${dir}/${MESSAGES_FILE}`;
	await appendFile(file, formatPostEntry(input), "utf8");
	return file;
}
