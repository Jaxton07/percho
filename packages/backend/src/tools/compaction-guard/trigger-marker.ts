/**
 * 「自研触发」一次性标记（spec D8）：让 UI 文案说对话（零 renderer 改动）。
 *
 * 背景：`ctx.compact()` 走的是 SDK 的**手动**路径，`compaction_start/end` 里 `reason:"manual"`，
 * 对话区于是显示「已压缩上下文 **· 手动**」——而用户什么都没点（本机制默认存在、不需要他知道）。
 *
 * 做法：护栏上报 `phase:"trigger"` 时置标记；在**事件转发咽喉点**遇到 `compaction_start`
 * 且 `reason === "manual"` 且标记在窗内 → 改写**副本**的 `reason` 为 `"threshold"`
 * （UI 已有「自动（上下文阈值）」文案），消费掉标记；同时改写紧跟的 `compaction_end`（同一 id 的
 * UI 卡片会被 end 覆盖 reason）。真实的 `/compact` 因为没有被标记，仍显示「手动」。
 *
 * 纪律：
 * - **永不改 SDK 事件对象本身**（只返回 `{...event, reason}` 的副本）；
 * - 纯逻辑 + 注入时钟，零 SDK / 零仓库 import，便于单测（并发、TTL、两条不串味）。
 */

/** 只会用到这三个字段（结构子集，避免依赖 SDK 类型） */
export interface CompactionReasonEvent {
	type: string;
	reason?: string;
}

export interface GuardTriggerMarkerOptions {
	/** 等待 `compaction_start` 的窗口（ms）：超时未出现就作废，避免误改后来的真实手动压缩 */
	ttlMs?: number;
	/** 已改写 `compaction_start` 后，等配对 `compaction_end` 的上限（ms，兜底防悬挂标记） */
	startedTtlMs?: number;
	now?: () => number;
}

interface Mark {
	/** 置标记时刻 */
	at: number;
	/** 已改写的 `compaction_start` 时刻；null = 还没等到 start */
	startedAt: number | null;
}

const DEFAULT_TTL_MS = 5_000;
const DEFAULT_STARTED_TTL_MS = 30 * 60_000;

export class GuardTriggerMarkers {
	private readonly marks = new Map<string, Mark>();
	private readonly ttlMs: number;
	private readonly startedTtlMs: number;
	private readonly now: () => number;

	constructor(options: GuardTriggerMarkerOptions = {}) {
		this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
		this.startedTtlMs = options.startedTtlMs ?? DEFAULT_STARTED_TTL_MS;
		this.now = options.now ?? (() => Date.now());
	}

	/** 护栏触发（`phase:"trigger"`, `source:"guard"`）时置标记 */
	mark(sessionId: string): void {
		this.marks.set(sessionId, { at: this.now(), startedAt: null });
	}

	/** 压缩收尾（`phase:"settled"`）/ 会话关闭时清掉 */
	clear(sessionId: string): void {
		this.marks.delete(sessionId);
	}

	/**
	 * 转发前的改写：命中就返回**副本**，否则原样返回入参（调用方无需判断）。
	 * 只有 `compaction_start`/`compaction_end` 意义上的事件才会被改写。
	 */
	rewrite<T extends CompactionReasonEvent>(sessionId: string, event: T): T {
		if (event.type !== "compaction_start" && event.type !== "compaction_end") return event;
		const mark = this.marks.get(sessionId);
		if (!mark) return event;
		if (event.reason !== "manual") {
			// 不是我们那一次（例如 SDK 阈值/溢出路径）⇒ 标记与它无关，直接作废
			this.marks.delete(sessionId);
			return event;
		}
		const now = this.now();
		if (event.type === "compaction_start") {
			if (mark.startedAt !== null) return event; // 一次触发只改一次 start
			if (now - mark.at > this.ttlMs) {
				this.marks.delete(sessionId); // 没等到 start，过期作废
				return event;
			}
			mark.startedAt = now;
			return { ...event, reason: "threshold" };
		}
		// compaction_end：只有 start 被改写过才跟着改写（UI 的卡片文案是 end 覆盖写入的）；
		// 配对消费掉标记，另设 startedTtlMs 兜底防悬挂
		if (mark.startedAt === null) return event;
		if (now - mark.startedAt > this.startedTtlMs) {
			this.marks.delete(sessionId);
			return event;
		}
		this.marks.delete(sessionId);
		return { ...event, reason: "threshold" };
	}

	/** 测试用：当前是否有活跃标记 */
	has(sessionId: string): boolean {
		return this.marks.has(sessionId);
	}
}
