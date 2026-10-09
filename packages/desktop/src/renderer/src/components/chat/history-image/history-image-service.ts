/**
 * 历史图片缩略图服务（**只做资源**：调度、缓存、URL 生命周期；不碰 React 渲染）。
 *
 * 资源契约（spec）在这里逐条落地：
 * - 活跃 slot ≤ 48（可见优先、缓冲次之）、等待队列 ≤ 48、worker 最多 1 个在途解码
 * - 离开加载区立即退订并丢待执行任务；在途任务用 token 丢迟到结果，最多保留 1 张在途
 * - 单任务 10s 超时 → 重置 worker；错误占位可重试，**绝不回退成原图 data: src**
 * - 非活跃 Blob 进 LRU（条数 + 字节双上限）；Blob URL 同一 key 共享、最后一个订阅者走时 revoke
 * - 身份用 WeakMap 指向 ImageInput 对象（不 hash base64）；也**不持有**原对象以外的强引用
 * - 切会话可 terminate 重建 worker；reset 清掉队列与在途，不能挂住下一个会话
 *
 * 渲染层（阶段 3）只通过 `acquire()` 拿句柄：`getSnapshot / subscribe / setVisible / retry / release`，
 * 用法与 `useSyncExternalStore` 对齐（快照对象在状态不变时引用不变）。
 */
import type { ImageInput } from "@percho/shared";
import { TASK_TIMEOUT_MS, THUMBNAIL_MAX_SIDE } from "./constants";
// `?worker` 是仓库里既有的 worker 出包方式（见 monaco-contribs.ts）：dev 与 build 都由 Vite 出独立
// chunk；改用 `new Worker(new URL(...))` 的写法在 build 里**不会**被静态分析到（实测 worker 没进产物）
import ThumbnailWorker from "./history-image.worker.ts?worker";
import {
	ActiveSlotRegistry,
	ThumbnailCache,
	type ThumbnailCacheEntry,
	type ThumbnailVisibility,
} from "./thumbnail-budget";
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
	cacheEntries: number;
	cacheBytes: number;
	urls: number;
	inFlight: boolean;
	lateDropped: number;
	timeouts: number;
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
	const counters = { lateDropped: 0, timeouts: 0, workerCreated: 0, workerTerminated: 0 };
	let nextKey = 0;
	let requestSeq = 0;
	let worker: Worker | null = null;
	let pending: PendingTask | null = null;

	function keyOf(image: ImageInput): number {
		const existing = identity.get(image);
		if (existing !== undefined) return existing;
		const key = ++nextKey;
		identity.set(image, key);
		return key;
	}

	/** 状态没变时保持同一个快照对象（useSyncExternalStore 会因此不重渲染） */
	function refreshSnapshot(record: KeyRecord): void {
		record.snapshot = {
			status: record.status,
			url: record.url,
			width: record.entry ? record.entry.width : null,
			height: record.entry ? record.entry.height : null,
		};
	}

	function notify(record: KeyRecord): void {
		refreshSnapshot(record);
		for (const listener of [...record.listeners]) listener();
	}

	function ensureUrl(record: KeyRecord): void {
		if (record.entry && !record.url) record.url = createObjectUrl(record.entry.blob);
	}

	function dropUrl(record: KeyRecord): void {
		if (!record.url) return;
		revokeObjectUrl(record.url);
		record.url = null;
	}

	function workerInstance(): Worker {
		if (worker) return worker;
		worker = createWorker();
		counters.workerCreated += 1;
		worker.addEventListener("message", (event: MessageEvent<ThumbnailResponse>) => {
			handleResponse(event.data);
		});
		const fail = () => failPending();
		worker.addEventListener("error", fail);
		worker.addEventListener("messageerror", fail);
		return worker;
	}

	function disposeWorker(): void {
		if (!worker) return;
		worker.terminate();
		worker = null;
		counters.workerTerminated += 1;
	}

	/** 重置当前在途任务：worker 异常与超时都走这里（保证不留僵尸任务） */
	function failPending(): void {
		const task = pending;
		pending = null;
		if (task?.timer) clearTimeout(task.timer);
		disposeWorker();
		if (!task) return;
		const record = records.get(task.key);
		if (record) {
			record.status = "error";
			registry.setState(task.key, "error");
			notify(record);
		}
		pump();
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
			record.status = "error";
			registry.setState(task.key, "error");
			notify(record);
		}
		pump();
	}

	function dispatch(key: number): void {
		const record = records.get(key);
		if (!record) return;
		record.status = "loading";
		registry.setState(key, "loading");
		notify(record);
		const requestId = ++requestSeq;
		pending = {
			requestId,
			key,
			timer: setTimeout(() => {
				if (pending?.requestId === requestId) {
					counters.timeouts += 1;
					failPending();
				}
			}, timeoutMs),
		};
		const request: ThumbnailRequest = { requestId, image: record.image, maxSide };
		workerInstance().postMessage(request);
	}

	/** 单一入口：决定「下一个跑谁」；worker 单飞，缓存命中不进 worker */
	function pump(): void {
		if (pending) return;
		registry.promoteIdle();
		while (registry.hasSlot()) {
			const key = registry.nextWaiting();
			if (key === null) return;
			const record = records.get(key);
			if (!record) {
				registry.unsubscribe(key);
				continue;
			}
			const cached = cache.get(key);
			if (cached) {
				record.entry = cached;
				record.status = "ready";
				registry.setState(key, "ready");
				ensureUrl(record);
				notify(record);
				continue;
			}
			dispatch(key);
			// 派发让等待队列空出一格：把之前被降级的缓冲项放回来，队列才能一直顶在上限
			registry.promoteIdle();
			return;
		}
	}

	function forget(key: number): void {
		const record = records.get(key);
		if (!record) return;
		if (record.entry && record.status === "ready") cache.set(key, record.entry);
		dropUrl(record);
		records.delete(key);
	}

	function acquire(image: ImageInput, acquireOptions: { visible?: boolean } = {}): ThumbnailHandle {
		const visible: ThumbnailVisibility = acquireOptions.visible === false ? "buffer" : "visible";
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
		target.refs += 1;
		registry.subscribe(key, visible);
		if (target.entry) {
			// 同一 key 的第二个订阅者（或句柄重入）：共享同一个 Blob URL，不重新解码
			ensureUrl(target);
			target.status = "ready";
			registry.setState(key, "ready");
			notify(target);
		}
		pump();

		let released = false;
		let ownListener: (() => void) | null = null;

		return {
			getSnapshot: () => target.snapshot,
			subscribe: (listener: () => void) => {
				ownListener = listener;
				target.listeners.add(listener);
				return () => {
					target.listeners.delete(listener);
					if (ownListener === listener) ownListener = null;
				};
			},
			setVisible: (nextVisible: boolean) => {
				if (released) return;
				registry.setVisibility(key, nextVisible ? "visible" : "buffer");
				pump();
			},
			retry: () => {
				if (released) return;
				// 错误占位可重试：清掉错误、重回队列；绝不回退成原图 src
				registry.requeue(key);
				record.status = record.entry ? "ready" : "idle";
				notify(record);
				pump();
			},
			release: () => {
				if (released) return;
				released = true;
				if (ownListener) {
					target.listeners.delete(ownListener);
					ownListener = null;
				}
				target.refs -= 1;
				if (registry.unsubscribe(key)) forget(key);
				pump();
			},
		};
	}

	function reset(): void {
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
