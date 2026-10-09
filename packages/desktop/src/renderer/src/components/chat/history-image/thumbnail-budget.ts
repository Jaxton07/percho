/**
 * 缩略图的**纯策略**层（无 DOM / 无 worker / 无 Blob URL）：活跃 slot + 等待队列 + LRU 缓存。
 *
 * 拆出来的目的：这些规则是 spec 里最容易写错又最该被钉住的部分（可见优先、不饿死可见图、
 * 去重、双上限淘汰、禁止 pin 撑大缓存），纯类才能在单测里穷举，不用起 Electron，
 * 也不靠「跑一遍看着还行」。
 */
import { ACTIVE_SLOT_LIMIT, CACHE_BYTE_LIMIT, CACHE_ENTRY_LIMIT, WAITING_LIMIT } from "./constants";

/** 可见性：可见（视口内）优先于缓冲（rootMargin 内但尚未进入视口） */
export type ThumbnailVisibility = "visible" | "buffer";

/**
 * idle = 登记了但没占队列（缓冲项超队列上限时被降级到这里，等有空位再排队）；
 * waiting = 在等待队列里；loading = 在途；ready = 有资源；error = 失败可重试。
 */
export type SlotState = "idle" | "waiting" | "loading" | "ready" | "error";

export interface ActiveSlotLimits {
	active: number;
	waiting: number;
}

interface SlotRecord {
	key: number;
	visibility: ThumbnailVisibility;
	state: SlotState;
	subscribers: number;
	/** 入队序号：同优先级 FIFO */
	seq: number;
}

/** 活跃 slot / 等待队列的登记簿：只管「谁该占 slot、下一个跑谁」，不碰资源本身 */
export class ActiveSlotRegistry {
	private records = new Map<number, SlotRecord>();
	private seq = 0;

	constructor(private limits: ActiveSlotLimits = { active: ACTIVE_SLOT_LIMIT, waiting: WAITING_LIMIT }) {}

	/** 订阅（同一 key 多次订阅只算一次资源需求；返回是否新建） */
	subscribe(key: number, visibility: ThumbnailVisibility): { state: SlotState; isNew: boolean } {
		const existing = this.records.get(key);
		if (existing) {
			existing.subscribers += 1;
			// 任一订阅者可见即视为可见：可见优先不能因为后来居下的订阅者退化
			if (visibility === "visible") existing.visibility = "visible";
			return { state: existing.state, isNew: false };
		}
		const state: SlotState =
			visibility === "visible" || this.waitingCount() < this.limits.waiting ? "waiting" : "idle";
		this.records.set(key, { key, visibility, state, subscribers: 1, seq: ++this.seq });
		this.enforceWaitingLimit();
		return { state, isNew: true };
	}

	/** 返回 true 表示该 key 已无订阅者（调用方负责释放资源） */
	unsubscribe(key: number): boolean {
		const record = this.records.get(key);
		if (!record) return true;
		record.subscribers -= 1;
		if (record.subscribers > 0) return false;
		this.records.delete(key);
		return true;
	}

	setVisibility(key: number, visibility: ThumbnailVisibility): void {
		const record = this.records.get(key);
		if (!record) return;
		if (visibility === "visible") {
			// 变可见必须能排上队：队列满时挤掉最老的缓冲项（绝不挤可见项）
			if (record.state === "idle" || !this.queued(record)) {
				record.visibility = "visible";
				record.state = "waiting";
				record.seq = ++this.seq;
				this.enforceWaitingLimit();
				return;
			}
			record.visibility = "visible";
			return;
		}
		if (record.subscribers <= 1) record.visibility = "buffer";
	}

	/** 重试：失败项回到等待队列 */
	requeue(key: number): void {
		const record = this.records.get(key);
		if (!record) return;
		record.state = "waiting";
		record.seq = ++this.seq;
		this.enforceWaitingLimit();
	}

	setState(key: number, state: SlotState): void {
		const record = this.records.get(key);
		if (record) record.state = state;
	}

	activeCount(): number {
		let count = 0;
		for (const record of this.records.values()) {
			if (record.state === "loading" || record.state === "ready") count += 1;
		}
		return count;
	}

	waitingCount(): number {
		let count = 0;
		for (const record of this.records.values()) if (record.state === "waiting") count += 1;
		return count;
	}

	idleCount(): number {
		let count = 0;
		for (const record of this.records.values()) if (record.state === "idle") count += 1;
		return count;
	}

	hasSlot(): boolean {
		return this.activeCount() < this.limits.active;
	}

	/** 队列有空位时把降级的缓冲项放回队列（单飞任务完成时调用，别让缓冲项被永久遗忘） */
	promoteIdle(): number {
		let promoted = 0;
		while (this.waitingCount() < this.limits.waiting) {
			const candidate = this.oldest("idle");
			if (!candidate) break;
			candidate.state = "waiting";
			candidate.seq = ++this.seq;
			promoted += 1;
		}
		return promoted;
	}

	/** 下一个该跑的任务：可见优先，其次 FIFO；没有则 null（不改状态，由调用方标记 loading） */
	nextWaiting(): number | null {
		const record = this.oldest("waiting");
		if (!record) return null;
		let best = record;
		for (const candidate of this.records.values()) {
			if (candidate.state !== "waiting") continue;
			const better =
				candidate.visibility === best.visibility
					? candidate.seq < best.seq
					: candidate.visibility === "visible" && best.visibility === "buffer";
			if (better) best = candidate;
		}
		return best.key;
	}

	state(key: number): SlotState | null {
		return this.records.get(key)?.state ?? null;
	}

	visibility(key: number): ThumbnailVisibility | null {
		return this.records.get(key)?.visibility ?? null;
	}

	subscribers(key: number): number {
		return this.records.get(key)?.subscribers ?? 0;
	}

	keys(): number[] {
		return [...this.records.keys()];
	}

	stats(): { active: number; waiting: number; idle: number; error: number; keys: number } {
		let error = 0;
		for (const record of this.records.values()) if (record.state === "error") error += 1;
		return {
			active: this.activeCount(),
			waiting: this.waitingCount(),
			idle: this.idleCount(),
			error,
			keys: this.records.size,
		};
	}

	clear(): void {
		this.records.clear();
	}

	/**
	 * 队列上限：超了就把**入队最早的缓冲项**降级为 idle，
	 * 绝不动可见项——否则可见图会被长历史里的缓冲请求挤到队尾（spec：不永久饿死可见图片）。
	 */
	private enforceWaitingLimit(): void {
		while (this.waitingCount() > this.limits.waiting) {
			const victim = this.oldestBufferWaiting();
			if (!victim) return;
			victim.state = "idle";
		}
	}

	private oldest(state: SlotState): SlotRecord | null {
		let best: SlotRecord | null = null;
		for (const record of this.records.values()) {
			if (record.state !== state) continue;
			if (!best || record.seq < best.seq) best = record;
		}
		return best;
	}

	private oldestBufferWaiting(): SlotRecord | null {
		let best: SlotRecord | null = null;
		for (const record of this.records.values()) {
			if (record.state !== "waiting" || record.visibility !== "buffer") continue;
			if (!best || record.seq < best.seq) best = record;
		}
		return best;
	}

	private queued(record: SlotRecord): boolean {
		return record.state === "waiting" && record.seq > 0;
	}
}

export interface ThumbnailCacheEntry {
	blob: Blob;
	width: number;
	height: number;
}

export interface ThumbnailCacheLimits {
	entries: number;
	bytes: number;
}

/**
 * 非活跃缩略图 Blob 的 LRU：条数与字节数**同时**约束；单条超字节上限直接不缓存
 * （spec：禁止 pin 导致 16MiB 上限名存实亡）。
 */
export class ThumbnailCache {
	private items = new Map<number, ThumbnailCacheEntry>();
	private order: number[] = [];
	private bytes = 0;

	constructor(
		private limits: ThumbnailCacheLimits = { entries: CACHE_ENTRY_LIMIT, bytes: CACHE_BYTE_LIMIT },
	) {}

	has(key: number): boolean {
		return this.items.has(key);
	}

	get(key: number): ThumbnailCacheEntry | undefined {
		const entry = this.items.get(key);
		if (!entry) return undefined;
		this.touch(key);
		return entry;
	}

	/** 返回是否真的缓存了（单条超字节上限时 false，不为它挤掉整个缓存） */
	set(key: number, entry: ThumbnailCacheEntry): boolean {
		if (entry.blob.size > this.limits.bytes) return false;
		const previous = this.items.get(key);
		if (previous) {
			this.bytes -= previous.blob.size;
			this.items.delete(key);
			this.order = this.order.filter((item) => item !== key);
		}
		this.items.set(key, entry);
		this.order.push(key);
		this.bytes += entry.blob.size;
		this.evict();
		return this.items.has(key);
	}

	delete(key: number): void {
		const entry = this.items.get(key);
		if (!entry) return;
		this.bytes -= entry.blob.size;
		this.items.delete(key);
		this.order = this.order.filter((item) => item !== key);
	}

	clear(): void {
		this.items.clear();
		this.order = [];
		this.bytes = 0;
	}

	stats(): { entries: number; bytes: number; limitEntries: number; limitBytes: number } {
		return {
			entries: this.items.size,
			bytes: this.bytes,
			limitEntries: this.limits.entries,
			limitBytes: this.limits.bytes,
		};
	}

	private touch(key: number): void {
		this.order = this.order.filter((item) => item !== key);
		this.order.push(key);
	}

	private evict(): void {
		while (this.order.length > this.limits.entries || this.bytes > this.limits.bytes) {
			const oldest = this.order.shift();
			if (oldest === undefined) return;
			const entry = this.items.get(oldest);
			if (!entry) continue;
			this.bytes -= entry.blob.size;
			this.items.delete(oldest);
		}
	}
}
