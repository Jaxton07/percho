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
 * idle = 登记了但没占队列（队列满时落在有界队列之外，需求仍在）；waiting = 在等待队列里；
 * loading = 在途；ready = 有资源；error = 失败可重试。
 */
export type SlotState = "idle" | "waiting" | "loading" | "ready" | "error";

export interface ActiveSlotLimits {
	active: number;
	waiting: number;
}

interface SlotRecord {
	key: number;
	/** 可见性按**每个订阅者**汇总：>0 即视为可见（不可被后订阅的缓冲降级） */
	visibleRefs: number;
	state: SlotState;
	subscribers: number;
	/** 入队序号：同优先级 FIFO */
	seq: number;
}

/**
 * 活跃 slot / 等待队列 / 可见性优先级的登记簿。
 *
 * 三条纪律（都在单测里钉住）：
 * 1. **优先级与资源生命周期正交**：loading/ready/error 只改优先级，不重排队、不离开 active 计数；
 * 2. **等待队列上限是硬的**（默认 48，按**总数**算，不是只算缓冲项）：超出的需求落到 idle
 *    （有界队列之外的需求记录，只引用既有 ImageInput，不复制字节、不占 active 资源），
 *    有空位时可见优先被放回队列；
 * 3. **可见项不被缓冲挡住**：降级时先挑最老的缓冲项；可见需求多于 active 预算时允许它们占位等待，
 *    但不放宽上限。
 */
export class ActiveSlotRegistry {
	private records = new Map<number, SlotRecord>();
	private seq = 0;

	constructor(private limits: ActiveSlotLimits = { active: ACTIVE_SLOT_LIMIT, waiting: WAITING_LIMIT }) {}

	/** 订阅（同一 key 多次订阅只算一次资源需求；返回是否新建） */
	subscribe(key: number, visible: boolean): { state: SlotState; isNew: boolean } {
		const existing = this.records.get(key);
		if (existing) {
			existing.subscribers += 1;
			if (visible) this.addVisibleRef(existing);
			return { state: existing.state, isNew: false };
		}
		const record: SlotRecord = {
			key,
			visibleRefs: visible ? 1 : 0,
			state: "waiting",
			subscribers: 1,
			seq: ++this.seq,
		};
		this.records.set(key, record);
		this.enforceWaitingLimit();
		return { state: record.state, isNew: true };
	}

	/** 某个句柄的可见性变化：只动可见性汇总与（idle 时的）入队，不碰 loading/ready/error */
	updateHandleVisibility(key: number, wasVisible: boolean, isVisible: boolean): void {
		const record = this.records.get(key);
		if (!record || wasVisible === isVisible) return;
		if (isVisible) {
			this.addVisibleRef(record);
			return;
		}
		record.visibleRefs = Math.max(0, record.visibleRefs - 1);
	}

	/** 返回 true 表示该 key 已无订阅者（调用方负责释放资源） */
	unsubscribe(key: number, visible: boolean): boolean {
		const record = this.records.get(key);
		if (!record) return true;
		record.subscribers -= 1;
		if (visible) record.visibleRefs = Math.max(0, record.visibleRefs - 1);
		if (record.subscribers > 0) return false;
		this.records.delete(key);
		return true;
	}

	/** 重试：**只对 error 生效**（loading/ready/waiting 的重复调用是 no-op） */
	requeue(key: number): boolean {
		const record = this.records.get(key);
		if (record?.state !== "error") return false;
		record.state = "waiting";
		record.seq = ++this.seq;
		this.enforceWaitingLimit();
		return true;
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

	/** 队列有空位时把队列外需求放回来：**可见优先**，其次 FIFO */
	promoteIdle(): number {
		let promoted = 0;
		while (this.waitingCount() < this.limits.waiting) {
			const candidate = this.oldestIdle(true) ?? this.oldestIdle(false);
			if (!candidate) break;
			candidate.state = "waiting";
			candidate.seq = ++this.seq;
			promoted += 1;
		}
		return promoted;
	}

	/** 下一个该跑的任务：可见优先，其次 FIFO；没有则 null（不改状态，由调用方标记 loading） */
	nextWaiting(): number | null {
		const best = this.pickWaiting();
		return best ? best.key : null;
	}

	/**
	 * 可被回收的 ready 项：**非可见**且最老。用于「真实可见等 slot 但预算已满」时让位
	 * （调用方负责撤 URL、把 Blob 放回非活跃 LRU、并把状态退回占位）。
	 */
	oldestEvictableReady(): number | null {
		let best: SlotRecord | null = null;
		for (const record of this.records.values()) {
			if (record.state !== "ready" || record.visibleRefs > 0) continue;
			if (!best || record.seq < best.seq) best = record;
		}
		return best ? best.key : null;
	}

	state(key: number): SlotState | null {
		return this.records.get(key)?.state ?? null;
	}

	visibility(key: number): ThumbnailVisibility | null {
		const record = this.records.get(key);
		if (!record) return null;
		return record.visibleRefs > 0 ? "visible" : "buffer";
	}

	subscribers(key: number): number {
		return this.records.get(key)?.subscribers ?? 0;
	}

	visibleRefs(key: number): number {
		return this.records.get(key)?.visibleRefs ?? 0;
	}

	keys(): number[] {
		return [...this.records.keys()];
	}

	/** 可见项不会被计数“藏起来”：visible 与 buffer 分列，便于断言预算真实性 */
	stats(): {
		active: number;
		waiting: number;
		idle: number;
		error: number;
		keys: number;
		visibleWaiting: number;
		bufferWaiting: number;
		visibleActive: number;
	} {
		let error = 0;
		let visibleWaiting = 0;
		let bufferWaiting = 0;
		let visibleActive = 0;
		for (const record of this.records.values()) {
			if (record.state === "error") error += 1;
			if (record.state === "waiting") {
				if (record.visibleRefs > 0) visibleWaiting += 1;
				else bufferWaiting += 1;
			}
			if ((record.state === "loading" || record.state === "ready") && record.visibleRefs > 0) {
				visibleActive += 1;
			}
		}
		return {
			active: this.activeCount(),
			waiting: this.waitingCount(),
			idle: this.idleCount(),
			error,
			keys: this.records.size,
			visibleWaiting,
			bufferWaiting,
			visibleActive,
		};
	}

	clear(): void {
		this.records.clear();
	}

	private addVisibleRef(record: SlotRecord): void {
		record.visibleRefs += 1;
		// 变可见必须能排上队：队列外的需求直接放回队列，并挤掉最老的缓冲项（若需要）
		if (record.state === "idle") {
			record.state = "waiting";
			record.seq = ++this.seq;
		}
		this.enforceWaitingLimit();
	}

	/**
	 * 队列上限（**总数**）：降级顺序 = 最老的缓冲项 → 最老的任意项。
	 * 刚入队/刚变可见的项 seq 最新，因此不会被自己挤掉；可见项优先保住在队列里的位置。
	 */
	private enforceWaitingLimit(): void {
		while (this.waitingCount() > this.limits.waiting) {
			// 先降级缓冲项（oldestWaiting(true)），全可见时才降级最老的等待项
			const victim = this.oldestWaiting(true) ?? this.oldestWaiting(false);
			if (!victim) return;
			victim.state = "idle";
		}
	}

	private pickWaiting(): SlotRecord | null {
		let best: SlotRecord | null = null;
		for (const record of this.records.values()) {
			if (record.state !== "waiting") continue;
			if (!best) {
				best = record;
				continue;
			}
			const bestVisible = best.visibleRefs > 0;
			const candidateVisible = record.visibleRefs > 0;
			if (candidateVisible !== bestVisible) {
				if (candidateVisible) best = record;
				continue;
			}
			if (record.seq < best.seq) best = record;
		}
		return best;
	}

	private oldestWaiting(buffer: boolean): SlotRecord | null {
		let best: SlotRecord | null = null;
		for (const record of this.records.values()) {
			if (record.state !== "waiting") continue;
			const isBuffer = record.visibleRefs === 0;
			if (isBuffer !== buffer) continue;
			if (!best || record.seq < best.seq) best = record;
		}
		return best;
	}

	private oldestIdle(visible: boolean): SlotRecord | null {
		let best: SlotRecord | null = null;
		for (const record of this.records.values()) {
			if (record.state !== "idle") continue;
			if (record.visibleRefs > 0 !== visible) continue;
			if (!best || record.seq < best.seq) best = record;
		}
		return best;
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
