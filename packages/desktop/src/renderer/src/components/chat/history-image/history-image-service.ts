/**
 * 历史图片缩略图服务（**只做资源**：调度、缓存、URL 生命周期；不碰 React 渲染）。
 *
 * 资源契约（spec）在这里逐条落地：
 * - 活跃 slot ≤ 48（可见优先、缓冲次之）、等待队列 ≤ 48、worker 最多 1 个在途解码
 * - **可见性只影响优先级，不影响资源生命周期**：ready/loading 的图切到 buffer 不会重新排队或掉出预算
 * - 真实可见需要 slot 而预算已满时，回收最老的**非可见 ready** 项让位（撤 URL、Blob 进 LRU、回占位）
 * - 离开加载区立即退订并丢待执行任务；在途任务用 token 丢迟到结果，最多保留 1 张在途
 * - 单任务 10s 超时、worker 异常、**new Worker / postMessage 同步抛**全都进 error 状态并可重试，
 *   不把异常抛给渲染层（否则调用方拿不到句柄 = 原图被强持有 + React 崩树）
 * - 非活跃 Blob 进 LRU（条数 + 字节双上限）；Blob URL 同一 key 共享、最后一个订阅者走时 revoke
 * - 身份用 WeakMap 指向 ImageInput 对象（不 hash base64）；缓存项只存 Blob 与几何，不持有原对象
 * - `reset()` 换代：旧句柄全部失效（不能碰新代资源、不能撤销新代 URL），队列/在途/缓存清空
 */
import type { ImageInput } from "@percho/shared";
import { TASK_TIMEOUT_MS, THUMBNAIL_MAX_SIDE } from "./constants";
// `?worker` 是仓库里既有的 worker 出包方式（见 monaco-contribs.ts）：dev 与 build 都由 Vite 出独立
// chunk。本地实测过 `new Worker(new URL(...))` 这种写法在**当前用法/构建条件**下 app build 里没出 chunk
// （未引用模块本来也会 tree-shake）；换 `?worker` 后再验。阶段 3 仍要在 app 最终产物 + file:// 下复验。
import ThumbnailWorker from "./history-image.worker.ts?worker";
import { ActiveSlotRegistry, ThumbnailCache, type ThumbnailCacheEntry } from "./thumbnail-budget";
import type { ThumbnailRequest, ThumbnailResponse } from "./thumbnail-protocol";

export type ThumbnailStatus = "idle" | "loading" | "ready" | "error";

export interface ThumbnailSnapshot {
	status: ThumbnailStatus;
	url: string | null;
	width: number | null;
	height: number | null;
}

export interface ThumbnailHandle {
	getSnapshot(): ThumbnailSnapshot;
	subscribe(listener: () => void): () => void;
	setVisible(visible: boolean): void;
	retry(): void;
	release(): void;
}

export interface ThumbnailServiceOptions {
	createWorker?: () => Worker;
	createObjectUrl?: (blob: Blob) => string;
	revokeObjectUrl?: (url: string) => void;
	maxSide?: number;
	timeoutMs?: number;
}

export interface ThumbnailServiceStats {
	active: number;
	waiting: number;
	idle: number;
	error: number;
	keys: number;
	visibleWaiting: number;
	bufferWaiting: number;
	visibleActive: number;
	cacheEntries: number;
	cacheBytes: number;
	urls: number;
	inFlight: boolean;
	lateDropped: number;
	timeouts: number;
	syncFailures: number;
	reclaimed: number;
	workerCreated: number;
	workerTerminated: number;
}

interface KeyRecord {
	key: number;
	image: ImageInput;
	status: ThumbnailStatus;
	entry: ThumbnailCacheEntry | null;
	url: string | null;
	refs: number;
	listeners: Set<() => void>;
	snapshot: ThumbnailSnapshot;
}

interface PendingTask {
	requestId: number;
	key: number;
	timer: ReturnType<typeof setTimeout> | null;
}

const STALE_SNAPSHOT: ThumbnailSnapshot = { status: "idle", url: null, width: null, height: null };

export function createThumbnailService(options: ThumbnailServiceOptions = {}) {
	const createWorker = options.createWorker ?? (() => new ThumbnailWorker());
	const createObjectUrl = options.createObjectUrl ?? ((blob: Blob) => URL.createObjectURL(blob));
	const revokeObjectUrl = options.revokeObjectUrl ?? ((url: string) => URL.revokeObjectURL(url));
	const maxSide = options.maxSide ?? THUMBNAIL_MAX_SIDE;
	const timeoutMs = options.timeoutMs ?? TASK_TIMEOUT_MS;

	const registry = new ActiveSlotRegistry();
	const cache = new ThumbnailCache();
	const identity = new WeakMap<ImageInput, number>();
	const records = new Map<number, KeyRecord>();
	const counters = {
		lateDropped: 0,
		timeouts: 0,
		syncFailures: 0,
		reclaimed: 0,
		workerCreated: 0,
		workerTerminated: 0,
	};
	let nextKey = 0;
	let requestSeq = 0;
	/** 换代号：reset 之后旧句柄一律失效（不能碰新代资源） */
	let generation = 0;
	let worker: Worker | null = null;
	let pending: PendingTask | null = null;
	let pumpScheduled = false;
	let pumping = false;
	let pumpRequested = false;

	function keyOf(image: ImageInput): number {
		const existing = identity.get(image);
		if (existing !== undefined) return existing;
		const key = ++nextKey;
		identity.set(image, key);
		return key;
	}

	/**
	 * 四个字段都没变就**保持同一个快照对象**：useSyncExternalStore 靠引用判等，
	 * 否则「ready 的同一 key 再来一个订阅者」这种无变化事件会让所有订阅者重渲染。
	 */
	function refreshSnapshot(record: KeyRecord): void {
		const current = record.snapshot;
		const next: ThumbnailSnapshot = {
			status: record.status,
			url: record.url,
			width: record.entry ? record.entry.width : null,
			height: record.entry ? record.entry.height : null,
		};
		if (
			current.status === next.status &&
			current.url === next.url &&
			current.width === next.width &&
			current.height === next.height
		) {
			return;
		}
		record.snapshot = next;
	}

	function notify(record: KeyRecord): void {
		refreshSnapshot(record);
		for (const listener of [...record.listeners]) {
			try {
				listener();
			} catch {
				// listener 是渲染层回调：它抛不能打断服务内务（订阅者自己负责错误边界）
			}
		}
	}

	function ensureUrl(record: KeyRecord): void {
		if (record.entry && !record.url) record.url = createObjectUrl(record.entry.blob);
	}

	function dropUrl(record: KeyRecord): void {
		if (!record.url) return;
		revokeObjectUrl(record.url);
		record.url = null;
	}

	/** 让位/失败/重置里的公共动作：资源退回非活跃缓存并清 URL */
	function demote(record: KeyRecord, state: "idle" | "error"): void {
		if (record.entry && state === "idle") cache.set(record.key, record.entry);
		dropUrl(record);
		record.entry = null;
		record.status = state;
		registry.setState(record.key, state);
		notify(record);
	}

	function workerInstance(): Worker {
		if (worker) return worker;
		const created = createWorker();
		worker = created;
		counters.workerCreated += 1;
		created.addEventListener("message", (event: MessageEvent<ThumbnailResponse>) => {
			handleResponse(event.data);
		});
		const fail = () => failPending();
		created.addEventListener("error", fail);
		created.addEventListener("messageerror", fail);
		return created;
	}

	function disposeWorker(): void {
		if (!worker) return;
		worker.terminate();
		worker = null;
		counters.workerTerminated += 1;
	}

	/** 重置当前在途任务：worker 异常、同步抛、超时都走这里（保证不留僵尸任务） */
	function failPending(): void {
		const task = pending;
		pending = null;
		if (task?.timer) clearTimeout(task.timer);
		disposeWorker();
		if (!task) return;
		const record = records.get(task.key);
		if (record) demote(record, "error");
		schedulePump();
	}

	/** 不能在 dispatch 失败时同步递归 pump（批量坏 worker 会栈溢出），用微任务收口 */
	function schedulePump(): void {
		if (pumpScheduled) return;
		pumpScheduled = true;
		queueMicrotask(() => {
			pumpScheduled = false;
			pump();
		});
	}

	function handleResponse(response: ThumbnailResponse | undefined): void {
		const requestId = response?.requestId;
		if (!pending || requestId !== pending.requestId) {
			// 迟到 / 已丢弃的结果：直接丢，不回缓存也不通知
			counters.lateDropped += 1;
			return;
		}
		const task = pending;
		pending = null;
		if (task.timer) clearTimeout(task.timer);
		const record = records.get(task.key);
		if (!record) {
			counters.lateDropped += 1;
			pump();
			return;
		}
		if (response?.ok) {
			record.entry = { blob: response.blob, width: response.width, height: response.height };
			record.status = "ready";
			registry.setState(task.key, "ready");
			ensureUrl(record);
			notify(record);
		} else {
			demote(record, "error");
		}
		pump();
	}

	function dispatch(record: KeyRecord): void {
		const requestId = ++requestSeq;
		const timer = setTimeout(() => {
			if (pending?.requestId === requestId) {
				counters.timeouts += 1;
				failPending();
			}
		}, timeoutMs);
		// **先建立「在途所有权」再暴露 loading 通知**：否则 listener 在通知里重入 pump 时
		// 会看到 pending 还是 null，于是又派发一条，把这条覆盖掉（实测踩到过 49/50 双投递）
		pending = { requestId, key: record.key, timer };
		record.status = "loading";
		registry.setState(record.key, "loading");
		try {
			const request: ThumbnailRequest = { requestId, image: record.image, maxSide };
			workerInstance().postMessage(request);
		} catch {
			// 同步失败（new Worker 被拦 / postMessage 抛）：进 error 状态机，句柄照样能 release/retry
			counters.syncFailures += 1;
			pending = null;
			clearTimeout(timer);
			disposeWorker();
			demote(record, "error");
			schedulePump();
			return;
		}
		notify(record);
		// 通知期间订阅者可能已经 release/reset 这条记录。这里只是**防御性**收口（变异验证显示它在当前
		// 实现下不改行为：释放后重入 pump 会因 pending 已建立而直接返回）。保留它是为了让
		// 「记录已不在、却还去推进队列」这件事不可能发生，而不是它当下承重。
		if (records.get(record.key) !== record) return;
		registry.promoteIdle();
	}

	/** 真实可见的请求等 slot 而预算已满时：回收最老的非可见 ready 项让位（不超预算、不多开 worker） */
	function reclaimSlot(): boolean {
		const victimKey = registry.oldestEvictableReady();
		if (victimKey === null) return false;
		const victim = records.get(victimKey);
		if (!victim) {
			registry.unsubscribe(victimKey, false);
			return true;
		}
		counters.reclaimed += 1;
		// 订阅者还在（只是让出 slot）：URL 撤掉、Blob 进非活跃 LRU、状态回占位，重新可见时命中缓存
		demote(victim, "idle");
		return true;
	}

	/**
	 * 单一入口：决定「下一个跑谁」；worker 单飞，缓存命中不进 worker。
	 *
	 * **重入保护**：notify 会同步回调渲染层，渲染层可能在回调里 acquire/release/reset，
	 * 也就是重入 pump。所以这里用 pumping 闸门 + 排空循环：重入请求只置位，由**最外层**
	 * 那一轮循环继续处理。这样「单飞」不依赖「listener 通常不重入」的假设。
	 */
	function pump(): void {
		if (pumping) {
			pumpRequested = true;
			return;
		}
		pumping = true;
		try {
			do {
				pumpRequested = false;
				pumpOnce();
			} while (pumpRequested);
		} finally {
			pumping = false;
		}
	}

	function pumpOnce(): void {
		if (pending) return;
		registry.promoteIdle();
		// 有界循环：每次迭代要么物化/派发一个、要么回收一个 slot、要么退出
		for (let guard = 0; guard < 4096; guard += 1) {
			const key = registry.nextWaiting();
			if (key === null) return;
			const record = records.get(key);
			if (!record) {
				registry.unsubscribe(key, false);
				continue;
			}
			if (!registry.hasSlot()) {
				const visible = registry.visibility(key) === "visible";
				if (!visible || !reclaimSlot()) return;
			}
			const cached = cache.get(key);
			if (cached) {
				// 取出即从非活跃缓存移除：Blob 改由活跃 record 持有，
				// 否则它同时算在 cacheBytes 与活跃预算里（stats 也就不能代表「非活跃缓存」）
				cache.delete(key);
				record.entry = cached;
				record.status = "ready";
				registry.setState(key, "ready");
				ensureUrl(record);
				notify(record);
				continue;
			}
			dispatch(record);
			return;
		}
	}

	function forget(key: number): void {
		const record = records.get(key);
		if (!record) return;
		if (record.entry && record.status === "ready") cache.set(key, record.entry);
		dropUrl(record);
		record.entry = null;
		record.status = "idle";
		records.delete(key);
	}

	function acquire(image: ImageInput, acquireOptions: { visible?: boolean } = {}): ThumbnailHandle {
		const ownGeneration = generation;
		let visible = acquireOptions.visible !== false;
		const key = keyOf(image);
		let record = records.get(key);
		if (!record) {
			record = {
				key,
				image,
				status: "idle",
				entry: null,
				url: null,
				refs: 0,
				listeners: new Set(),
				snapshot: { status: "idle", url: null, width: null, height: null },
			};
			records.set(key, record);
		}
		const target = record;
		/** 可用性 = 同一代 且 未释放（release 之后的读/订阅/操作一律失效，与 reset 处理一致） */
		const usable = () => ownGeneration === generation && !released;
		target.refs += 1;
		registry.subscribe(key, visible);
		if (target.entry) {
			// 同一 key 的第二个订阅者（或句柄重入）：共享同一个 Blob URL，不重新解码，也不动状态
			ensureUrl(target);
			target.status = "ready";
			registry.setState(key, "ready");
			notify(target);
		}
		pump();

		let released = false;
		let ownListener: (() => void) | null = null;

		return {
			getSnapshot: () => (usable() ? target.snapshot : STALE_SNAPSHOT),
			subscribe: (listener: () => void) => {
				if (!usable()) return () => {};
				ownListener = listener;
				target.listeners.add(listener);
				return () => {
					target.listeners.delete(listener);
					if (ownListener === listener) ownListener = null;
				};
			},
			setVisible: (nextVisible: boolean) => {
				// 只动优先级：ready/loading 的图不会因为切可见性重新排队或掉出预算
				if (!usable() || nextVisible === visible) return;
				registry.updateHandleVisibility(key, visible, nextVisible);
				visible = nextVisible;
				pump();
			},
			retry: () => {
				if (!usable()) return;
				// 只对 error 生效；错误占位可重试，绝不回退成原图 src
				if (!registry.requeue(key)) return;
				target.status = target.entry ? "ready" : "idle";
				notify(target);
				pump();
			},
			release: () => {
				if (released) return;
				released = true;
				if (ownGeneration !== generation) return;
				if (ownListener) {
					target.listeners.delete(ownListener);
					ownListener = null;
				}
				target.refs -= 1;
				if (registry.unsubscribe(key, visible)) forget(key);
				pump();
			},
		};
	}

	function reset(): void {
		generation += 1;
		const task = pending;
		pending = null;
		if (task?.timer) clearTimeout(task.timer);
		disposeWorker();
		for (const record of records.values()) {
			dropUrl(record);
			record.entry = null;
			record.status = "idle";
			notify(record);
		}
		records.clear();
		registry.clear();
		cache.clear();
	}

	function stats(): ThumbnailServiceStats {
		const cacheStats = cache.stats();
		let urls = 0;
		for (const record of records.values()) if (record.url) urls += 1;
		return {
			...registry.stats(),
			cacheEntries: cacheStats.entries,
			cacheBytes: cacheStats.bytes,
			urls,
			inFlight: pending !== null,
			...counters,
		};
	}

	return { acquire, reset, stats };
}

export type ThumbnailService = ReturnType<typeof createThumbnailService>;

let singleton: ThumbnailService | null = null;

/** 进程内单例（App 级共享一份 48 slots 与一份 LRU）；测试请用 `createThumbnailService` 造新实例 */
export function thumbnailService(): ThumbnailService {
	if (!singleton) singleton = createThumbnailService();
	return singleton;
}
