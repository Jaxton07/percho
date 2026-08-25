import { createHash } from "node:crypto";
import { createLogger } from "../../log";

const log = createLogger("channel-watch-guard");

/**
 * 防环状态机（spec D5，四层中除防抖外的三层 + 暂停/恢复）：
 *
 * 1. 自写抑制：markSelfWrite 记录本进程 write/edit 目标路径 + 时间戳，
 *    watcher 事件命中且 <10s → isSelfWrite=true 抑制。bash 写入路径不可靠 →
 *    由 2/3 层兜底（不解析 bash 命令）。
 * 2. 内容 hash 去重：投递时记录文件快照 hash；下次事件 hash 相同 → 不投递
 *    （兑住 bash 旁路自写、以及「打开文件未改」类伪事件）。
 * 4. 乒乓上限：10 分钟窗口内同频道唤醒 ≥6 次且无真实用户消息介入 → 暂停该频道
 *    投递（resume 需显式调用：重新 subscribe / 设置页恢复）。
 *
 * 纯内存状态（不持久化——重启即清零是安全侧默认）；时间函数可注入（单测）。
 */

/** 自写抑制窗口：watcher 事件命中距本进程写入 <10s → 抑制 */
export const SELF_WRITE_WINDOW_MS = 10_000;
/** 乒乓滑动窗口 */
export const PINGPONG_WINDOW_MS = 10 * 60_000;
/** 窗口内唤醒次数上限 */
export const PINGPONG_MAX_WAKES = 6;

export interface DeliverDecision {
	deliver: boolean;
	/** 决策原因（日志/调试用） */
	reason: "ok" | "self-write" | "hash-unchanged" | "paused";
}

export interface LoopGuardOptions {
	/** 时间函数（默认 Date.now，单测注入） */
	now?: () => number;
}

/** 计算内容 hash（sha256 前 16 hex；空内容 → "empty"） */
export function contentHash(content: string): string {
	if (content.length === 0) return "empty";
	return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
}

export class LoopGuard {
	private readonly now: () => number;
	/** 本进程自写路径 → 最近写入时间（绝对路径，normalize 后精确匹配 + 后缀匹配兜底） */
	private readonly selfWrites = new Map<string, number>();
	/** 上次投递时的文件快照 hash（key = topic + "/" + relPath） */
	private readonly deliveredHashes = new Map<string, string>();
	/** 各频道唤醒时间戳（滑动窗口） */
	private readonly wakeHistory = new Map<string, number[]>();
	/** 已暂停频道 → 暂停时间 */
	private readonly pausedTopics = new Map<string, number>();

	constructor(options: LoopGuardOptions = {}) {
		this.now = options.now ?? Date.now;
	}

	// --- 层 1：自写抑制 ---

	/** tool_call 钩子记录本进程 write/edit 的目标文件 */
	markSelfWrite(absPath: string): void {
		this.selfWrites.set(absPath, this.now());
		// 上限防泄漏（长会话海量写入）
		if (this.selfWrites.size > 1000) {
			const cutoff = this.now() - SELF_WRITE_WINDOW_MS;
			for (const [p, t] of this.selfWrites) {
				if (t < cutoff) this.selfWrites.delete(p);
			}
		}
	}

	/** 事件目标（绝对路径）是否命中 <10s 自写窗口（含父目录写入命中子文件事件的场景） */
	isSelfWrite(absPath: string): boolean {
		const at = this.now();
		for (const [p, t] of this.selfWrites) {
			if (at - t >= SELF_WRITE_WINDOW_MS) continue;
			// 精确命中，或自写的是该文件的父目录（写父目录内容也算写文件）
			if (p === absPath || absPath.startsWith(`${p}/`)) return true;
		}
		return false;
	}

	// --- 层 2：hash 去重 ---

	private hashKey(topic: string, relPath: string): string {
		return `${topic}/${relPath}`;
	}

	/** 投递判定（watcher 防抖后调用）：暂停 > 自写 > hash 变化 */
	shouldDeliver(topic: string, relPath: string, currentHash: string, absPath?: string): DeliverDecision {
		if (this.pausedTopics.has(topic)) return { deliver: false, reason: "paused" };
		if (absPath && this.isSelfWrite(absPath)) return { deliver: false, reason: "self-write" };
		const prev = this.deliveredHashes.get(this.hashKey(topic, relPath));
		if (prev !== undefined && prev === currentHash) {
			return { deliver: false, reason: "hash-unchanged" };
		}
		return { deliver: true, reason: "ok" };
	}

	/** 成功投递后记录快照 hash + 乒乓计数；返回是否触发暂停 */
	recordDelivered(topic: string, relPath: string, hash: string): boolean {
		this.deliveredHashes.set(this.hashKey(topic, relPath), hash);
		return this.recordWake(topic);
	}

	// --- 层 4：乒乓上限 ---

	/** 记录一次频道唤醒（投递即唤醒）；返回是否触发暂停 */
	recordWake(topic: string): boolean {
		const at = this.now();
		const history = (this.wakeHistory.get(topic) ?? []).filter((t) => at - t < PINGPONG_WINDOW_MS);
		history.push(at);
		this.wakeHistory.set(topic, history);
		if (history.length >= PINGPONG_MAX_WAKES) {
			this.pausedTopics.set(topic, at);
			this.wakeHistory.delete(topic);
			log.warn("channel-watch 乒乓上限触发，暂停频道投递", { topic, wakes: history.length });
			return true;
		}
		return false;
	}

	/** 真实用户消息介入：清空全部频道计数（环烧需「无真实用户消息介入」才成立） */
	noteUserMessage(): void {
		if (this.wakeHistory.size > 0) this.wakeHistory.clear();
	}

	/** 频道是否已暂停 */
	isPaused(topic: string): boolean {
		return this.pausedTopics.has(topic);
	}

	/** 当前已暂停频道列表（notify / channel_list 展示用） */
	pausedTopicList(): Array<{ topic: string; since: number }> {
		return [...this.pausedTopics.entries()].map(([topic, since]) => ({ topic, since }));
	}

	/** 恢复频道投递（重新 subscribe / 设置页恢复） */
	resumeTopic(topic: string): void {
		this.pausedTopics.delete(topic);
		this.wakeHistory.delete(topic);
	}

	// --- 清理 ---

	/** 取消订阅时清理该频道全部状态 */
	forgetTopic(topic: string): void {
		this.pausedTopics.delete(topic);
		this.wakeHistory.delete(topic);
		const prefix = `${topic}/`;
		for (const key of this.deliveredHashes.keys()) {
			if (key.startsWith(prefix)) this.deliveredHashes.delete(key);
		}
	}

	/** session_shutdown 清理（watcher 由 extension 侧 stop，这里只清判定状态） */
	reset(): void {
		this.selfWrites.clear();
		this.deliveredHashes.clear();
		this.wakeHistory.clear();
		this.pausedTopics.clear();
	}
}
