import type { ImageInput } from "@percho/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ACTIVE_SLOT_LIMIT,
	CACHE_BYTE_LIMIT,
	TASK_TIMEOUT_MS,
	THUMBNAIL_MAX_SIDE,
	WAITING_LIMIT,
} from "./constants";
import {
	createHistoryImageObserver,
	type HistoryImageVisibility,
	historyImageObserver,
} from "./history-image-observer";
import { createThumbnailService } from "./history-image-service";
import { ActiveSlotRegistry, ThumbnailCache } from "./thumbnail-budget";
import type { ThumbnailRequest, ThumbnailResponse } from "./thumbnail-protocol";

const image = (seed: string): ImageInput => ({ mimeType: "image/png", data: `data-${seed}` });

class FakeWorker {
	posted: ThumbnailRequest[] = [];
	terminated = 0;
	throwOnPost = false;
	private messageListeners: ((event: { data: ThumbnailResponse }) => void)[] = [];
	private errorListeners: (() => void)[] = [];

	postMessage(request: ThumbnailRequest): void {
		if (this.throwOnPost) throw new Error("postMessage 被拦");
		this.posted.push(request);
	}

	addEventListener(type: string, listener: never): void {
		if (type === "message") this.messageListeners.push(listener);
		else this.errorListeners.push(listener);
	}

	terminate(): void {
		this.terminated += 1;
	}

	emit(response: ThumbnailResponse): void {
		for (const listener of [...this.messageListeners]) listener({ data: response });
	}

	emitError(): void {
		for (const listener of [...this.errorListeners]) listener();
	}

	completeLast(overrides: Partial<{ width: number; height: number; bytes: number }> = {}): void {
		const request = lastRequestOf(this);
		const bytes = overrides.bytes ?? 1000;
		this.emit({
			requestId: request.requestId,
			ok: true,
			blob: new Blob([new Uint8Array(bytes)], { type: "image/png" }),
			width: overrides.width ?? 384,
			height: overrides.height ?? 240,
		});
	}

	get lastRequest(): ThumbnailRequest | undefined {
		return this.posted[this.posted.length - 1];
	}
}

/** 取最近一条投递（拿不到就报错，避免测试里满屏 possibly undefined） */
function lastRequestOf(worker: FakeWorker): ThumbnailRequest {
	const request = worker.posted[worker.posted.length - 1];
	if (!request) throw new Error("没有投递过任务");
	return request;
}

function workerOf(workers: FakeWorker[]): FakeWorker {
	const worker = workers[workers.length - 1];
	if (!worker) throw new Error("还没有创建 worker");
	return worker;
}

function fakeService(options: { timeoutMs?: number; createWorker?: () => Worker } = {}) {
	const workers: FakeWorker[] = [];
	const createdUrls: string[] = [];
	const revokedUrls: string[] = [];
	const service = createThumbnailService({
		createWorker:
			options.createWorker ??
			(() => {
				const worker = new FakeWorker();
				workers.push(worker);
				return worker as unknown as Worker;
			}),
		createObjectUrl: () => {
			const url = `blob:fake-${createdUrls.length + 1}`;
			createdUrls.push(url);
			return url;
		},
		revokeObjectUrl: (url) => {
			revokedUrls.push(url);
		},
		timeoutMs: options.timeoutMs,
	});
	return { service, workers, createdUrls, revokedUrls, worker: () => workerOf(workers) };
}

describe("ActiveSlotRegistry（活跃 slot 与等待队列的纯策略）", () => {
	it("活跃 slot 上限：满了就没有下一个任务", () => {
		const registry = new ActiveSlotRegistry({ active: 2, waiting: 8 });
		for (let key = 1; key <= 4; key += 1) registry.subscribe(key, true);
		expect(registry.hasSlot()).toBe(true);
		registry.setState(registry.nextWaiting() as number, "loading");
		registry.setState(registry.nextWaiting() as number, "ready");
		expect(registry.activeCount()).toBe(2);
		expect(registry.hasSlot()).toBe(false);
	});

	it("等待队列上限是**总数**硬的（不只是缓冲项）", () => {
		const registry = new ActiveSlotRegistry({ active: 10, waiting: 3 });
		for (let key = 1; key <= 6; key += 1) registry.subscribe(key, true);
		expect(registry.waitingCount()).toBe(3);
		expect(registry.idleCount()).toBe(3);
		expect(registry.stats().visibleWaiting).toBe(3);
		// 队列腾位置后放回来，仍然不超过上限
		registry.setState(1, "loading");
		registry.promoteIdle();
		expect(registry.waitingCount()).toBe(3);
		expect(registry.idleCount()).toBe(2);
	});

	it("可见优先：后到的可见请求排在缓冲项前面；队列外的可见需求会先回队列", () => {
		const registry = new ActiveSlotRegistry({ active: 8, waiting: 2 });
		registry.subscribe(1, false);
		registry.subscribe(2, false);
		registry.subscribe(3, true);
		expect(registry.nextWaiting()).toBe(3);
		expect(registry.visibility(1)).toBe("buffer");
	});

	it("队列满时降级的是最老的缓冲项，可见项保住队列位置", () => {
		const registry = new ActiveSlotRegistry({ active: 8, waiting: 2 });
		registry.subscribe(1, true);
		registry.subscribe(2, false);
		registry.subscribe(3, false);
		expect(registry.state(1)).toBe("waiting");
		expect(registry.visibility(1)).toBe("visible");
		expect(registry.state(2)).toBe("idle");
		expect(registry.nextWaiting()).toBe(1);
	});

	it("优先级与资源生命周期正交：ready/loading/error 不因可见性变化重新排队", () => {
		const registry = new ActiveSlotRegistry({ active: 8, waiting: 8 });
		for (const state of ["loading", "ready", "error"] as const) {
			registry.subscribe(1, false);
			registry.setState(1, state);
			registry.updateHandleVisibility(1, false, true);
			expect(registry.state(1)).toBe(state);
			expect(registry.visibility(1)).toBe("visible");
			expect(registry.activeCount()).toBe(state === "error" ? 0 : 1);
			registry.unsubscribe(1, true);
		}
	});

	it("可见性按每个订阅者计数：一个句柄切缓冲不影响另一个可见句柄", () => {
		const registry = new ActiveSlotRegistry();
		registry.subscribe(7, true); // 句柄 A 可见
		registry.subscribe(7, false); // 句柄 B 缓冲
		expect(registry.subscribers(7)).toBe(2);
		expect(registry.visibleRefs(7)).toBe(1);
		expect(registry.visibility(7)).toBe("visible");
		registry.updateHandleVisibility(7, true, false); // A 变缓冲
		expect(registry.visibleRefs(7)).toBe(0);
		expect(registry.visibility(7)).toBe("buffer");
		expect(registry.unsubscribe(7, false)).toBe(false);
		expect(registry.unsubscribe(7, false)).toBe(true);
	});

	it("重复上报同一可见性不会重复计数（防可见引用漂移）", () => {
		const registry = new ActiveSlotRegistry();
		registry.subscribe(1, true);
		expect(registry.visibleRefs(1)).toBe(1);
		registry.updateHandleVisibility(1, true, true);
		registry.subscribe(1, true);
		expect(registry.visibleRefs(1)).toBe(2);
		registry.updateHandleVisibility(1, false, false);
		expect(registry.visibleRefs(1)).toBe(2);
		registry.unsubscribe(1, true);
		registry.unsubscribe(1, true);
		expect(registry.visibleRefs(1)).toBe(0);
	});

	it("requeue 只对 error 生效（重复 retry 不会把在途任务重排队）", () => {
		const registry = new ActiveSlotRegistry();
		registry.subscribe(1, true);
		expect(registry.requeue(1)).toBe(false);
		expect(registry.state(1)).toBe("waiting");
		registry.setState(1, "loading");
		expect(registry.requeue(1)).toBe(false);
		expect(registry.state(1)).toBe("loading");
		registry.setState(1, "error");
		expect(registry.requeue(1)).toBe(true);
		expect(registry.state(1)).toBe("waiting");
	});

	it("可回收的只有「非可见 ready」", () => {
		const registry = new ActiveSlotRegistry();
		registry.subscribe(1, false);
		registry.subscribe(2, true);
		registry.setState(1, "ready");
		registry.setState(2, "ready");
		expect(registry.oldestEvictableReady()).toBe(1);
		registry.updateHandleVisibility(1, false, true);
		expect(registry.oldestEvictableReady()).toBeNull();
	});

	it("上界的默认值就是 spec 的 48 / 48", () => {
		expect(ACTIVE_SLOT_LIMIT).toBe(48);
		expect(WAITING_LIMIT).toBe(48);
		expect(THUMBNAIL_MAX_SIDE).toBe(384);
		expect(TASK_TIMEOUT_MS).toBe(10_000);
	});
});

describe("ThumbnailCache（LRU 双上限）", () => {
	const entry = (size: number) => ({
		blob: new Blob([new Uint8Array(size)], { type: "image/png" }),
		width: 384,
		height: 240,
	});

	it("条数上限：超出淘汰最久未用的", () => {
		const cache = new ThumbnailCache({ entries: 2, bytes: CACHE_BYTE_LIMIT });
		cache.set(1, entry(10));
		cache.set(2, entry(10));
		cache.set(3, entry(10));
		expect(cache.stats().entries).toBe(2);
		expect(cache.has(1)).toBe(false);
		expect(cache.has(3)).toBe(true);
	});

	it("get 会刷新 LRU 位置", () => {
		const cache = new ThumbnailCache({ entries: 2, bytes: CACHE_BYTE_LIMIT });
		cache.set(1, entry(10));
		cache.set(2, entry(10));
		cache.get(1);
		cache.set(3, entry(10));
		expect(cache.has(1)).toBe(true);
		expect(cache.has(2)).toBe(false);
	});

	it("字节上限：总字节超了就按 LRU 淘汰，账目对齐", () => {
		const cache = new ThumbnailCache({ entries: 10, bytes: 100 });
		cache.set(1, entry(60));
		cache.set(2, entry(60));
		expect(cache.stats().entries).toBe(1);
		expect(cache.stats().bytes).toBe(60);
		cache.delete(2);
		expect(cache.stats()).toMatchObject({ entries: 0, bytes: 0 });
	});

	it("单条超字节上限直接不缓存（不许为了它把整个缓存挤空）", () => {
		const cache = new ThumbnailCache({ entries: 10, bytes: 100 });
		cache.set(1, entry(20));
		expect(cache.set(2, entry(200))).toBe(false);
		expect(cache.stats()).toMatchObject({ entries: 1, bytes: 20 });
		expect(cache.has(1)).toBe(true);
	});
});

describe("缩略图服务：去重 / 缓存 / URL 生命周期", () => {
	it("取一次图只发一条任务，请求带的是同一个 ImageInput 引用（不预先复制字节）", () => {
		const { service, worker } = fakeService();
		const source = image("a");
		const handle = service.acquire(source);
		expect(handle.getSnapshot().status).toBe("loading");
		expect(worker().posted).toHaveLength(1);
		expect(worker().lastRequest?.image).toBe(source);
		expect(worker().lastRequest?.maxSide).toBe(384);
		worker().completeLast();
		expect(handle.getSnapshot()).toMatchObject({ status: "ready", width: 384, height: 240 });
		expect(handle.getSnapshot().url).toBe("blob:fake-1");
	});

	it("同一张图两个订阅者共享一次解码与一个 Blob URL，最后一个走时才 revoke", () => {
		const { service, worker, createdUrls, revokedUrls } = fakeService();
		const source = image("shared");
		const first = service.acquire(source);
		const second = service.acquire(source);
		expect(worker().posted).toHaveLength(1);
		worker().completeLast();
		expect(first.getSnapshot().url).toBe(second.getSnapshot().url);
		expect(createdUrls).toHaveLength(1);
		first.release();
		expect(revokedUrls).toHaveLength(0);
		second.release();
		expect(revokedUrls).toEqual([createdUrls[0]]);
		expect(service.stats().urls).toBe(0);
	});

	it("释放后立即重入：命中 LRU 缓存，不再进 worker，且同步就是 ready", () => {
		const { service, worker } = fakeService();
		const source = image("cache-hit");
		const handle = service.acquire(source);
		worker().completeLast();
		handle.release();
		expect(service.stats().cacheEntries).toBe(1);
		const again = service.acquire(source);
		expect(again.getSnapshot().status).toBe("ready");
		expect(worker().posted).toHaveLength(1);
	});

	it("身份按对象而不是 base64：两个内容相同的对象各自缩图（不 hash base64 的代价，明确接受）", () => {
		const { service, worker } = fakeService();
		service.acquire(image("same-content"));
		service.acquire(image("same-content"));
		expect(worker().posted).toHaveLength(1);
		worker().completeLast();
		expect(worker().posted).toHaveLength(2);
	});

	it("StrictMode 式乱序 cleanup：先释放后订阅的那个也要能正确收尾", () => {
		const { service, worker, revokedUrls } = fakeService();
		const source = image("strict");
		const first = service.acquire(source);
		const second = service.acquire(source);
		worker().completeLast();
		second.release();
		first.release();
		expect(service.stats()).toMatchObject({ keys: 0, urls: 0, cacheEntries: 1 });
		expect(revokedUrls).toHaveLength(1);
	});

	it("可见性变化：调度顺序上「可见」插到「缓冲」前面（已经在跑的那张不抢占）", () => {
		const { service, worker } = fakeService();
		service.acquire(image("buffer-1"), { visible: false });
		service.acquire(image("buffer-2"), { visible: false });
		const visible = service.acquire(image("visible"));
		expect(worker().posted).toHaveLength(1);
		expect(worker().lastRequest?.image.data).toBe("data-buffer-1");
		worker().completeLast();
		expect(worker().posted).toHaveLength(2);
		expect(worker().lastRequest?.image.data).toBe("data-visible");
		expect(visible.getSnapshot().status).toBe("loading");
	});

	it("setVisible 只动优先级：ready 的图不会重新排队、不会掉出预算、URL 不变", () => {
		const { service, worker, createdUrls } = fakeService();
		const handle = service.acquire(image("toggle"), { visible: false });
		worker().completeLast();
		const before = handle.getSnapshot();
		expect(before.status).toBe("ready");
		const activeBefore = service.stats().active;
		handle.setVisible(true);
		handle.setVisible(false);
		handle.setVisible(true);
		expect(worker().posted).toHaveLength(1);
		expect(createdUrls).toHaveLength(1);
		expect(handle.getSnapshot()).toEqual(before);
		expect(service.stats().active).toBe(activeBefore);
		expect(service.stats().waiting).toBe(0);
	});

	it("真实可见等 slot 而预算已满：回收最老的非可见 ready 让位，不超过预算", () => {
		const { service, workers, revokedUrls } = fakeService();
		const total = service.stats().active + ACTIVE_SLOT_LIMIT;
		const buffers = [];
		for (let index = 0; index < ACTIVE_SLOT_LIMIT; index += 1) {
			buffers.push(service.acquire(image(`bulk-${index}`), { visible: false }));
		}
		for (let index = 0; index < ACTIVE_SLOT_LIMIT; index += 1) workerOf(workers).completeLast();
		expect(service.stats().active).toBe(ACTIVE_SLOT_LIMIT);
		expect(service.stats().urls).toBe(ACTIVE_SLOT_LIMIT);
		void total;

		const visible = service.acquire(image("visible-needs-slot"));
		expect(workerOf(workers).posted).toHaveLength(ACTIVE_SLOT_LIMIT + 1);
		expect(service.stats().active).toBeLessThanOrEqual(ACTIVE_SLOT_LIMIT);
		expect(service.stats().reclaimed).toBe(1);
		expect(buffers[0]?.getSnapshot()).toMatchObject({ status: "idle", url: null });
		expect(revokedUrls.length).toBe(1);
		workerOf(workers).completeLast();
		expect(visible.getSnapshot().status).toBe("ready");
	});

	it("缓冲请求超过队列上限：等待队列不超过 48，其余落在队列外，有空位会补上", () => {
		const { service, worker } = fakeService();
		for (let index = 0; index < WAITING_LIMIT + 12; index += 1) {
			service.acquire(image(`bulk-${index}`), { visible: false });
		}
		expect(service.stats().waiting).toBeLessThanOrEqual(WAITING_LIMIT);
		expect(service.stats().idle).toBeGreaterThan(0);
		const idleBefore = service.stats().idle;
		worker().completeLast();
		expect(service.stats().idle).toBeLessThan(idleBefore);
	});
});

describe("缩略图服务：取消 / 迟到 / 超时 / 重置 / 同步失败", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("在途任务释放后：迟到结果被 token 丢掉，不污染缓存", () => {
		const { service, worker } = fakeService();
		const handle = service.acquire(image("late"));
		const requestId = lastRequestOf(worker()).requestId;
		handle.release();
		worker().emit({
			requestId,
			ok: true,
			blob: new Blob([new Uint8Array(10)], { type: "image/png" }),
			width: 384,
			height: 240,
		});
		expect(service.stats().lateDropped).toBe(1);
		expect(service.stats().cacheEntries).toBe(0);
		expect(service.stats().keys).toBe(0);
	});

	it("串台响应：旧任务的响应在新任务在途时重复投递，必须丢掉而不是算到新任务头上", () => {
		const { service, worker } = fakeService();
		const staleResponse = (requestId: number) => ({
			requestId,
			ok: true as const,
			blob: new Blob([new Uint8Array(10)], { type: "image/png" }),
			width: 384,
			height: 240,
		});
		const dropped = service.acquire(image("stale"));
		const staleRequestId = lastRequestOf(worker()).requestId;
		dropped.release();
		worker().emit(staleResponse(staleRequestId));
		const fresh = service.acquire(image("fresh"));
		expect(worker().posted).toHaveLength(2);
		expect(fresh.getSnapshot().status).toBe("loading");
		worker().emit(staleResponse(staleRequestId));
		expect(fresh.getSnapshot()).toMatchObject({ status: "loading", url: null });
		expect(service.stats().lateDropped).toBe(2);
		expect(service.stats().cacheEntries).toBe(0);
		worker().completeLast();
		expect(fresh.getSnapshot().status).toBe("ready");
	});

	it("超时：重置 worker、标记错误、可重试（不回退成原图 src）", () => {
		const { service, workers } = fakeService({ timeoutMs: 1000 });
		const handle = service.acquire(image("timeout"));
		expect(workers).toHaveLength(1);
		vi.advanceTimersByTime(1000);
		expect(handle.getSnapshot().status).toBe("error");
		expect(workers[0]?.terminated).toBe(1);
		expect(service.stats().timeouts).toBe(1);
		expect(handle.getSnapshot().url).toBeNull();
		handle.retry();
		expect(workers.length).toBeGreaterThanOrEqual(2);
		expect(service.stats().inFlight).toBe(true);
		workerOf(workers).completeLast();
		expect(handle.getSnapshot().status).toBe("ready");
	});

	it("worker 异常：同样走重置路径，且没有僵尸在途", () => {
		const { service, workers } = fakeService();
		const handle = service.acquire(image("worker-error"));
		workers[0]?.emitError();
		expect(handle.getSnapshot().status).toBe("error");
		expect(service.stats().inFlight).toBe(false);
		expect(workers[0]?.terminated).toBe(1);
	});

	it("worker 报错（ok:false）：停在错误态，可重试", () => {
		const { service, worker } = fakeService();
		const handle = service.acquire(image("bad-image"));
		worker().emit({ requestId: lastRequestOf(worker()).requestId, ok: false, error: "解码失败" });
		expect(handle.getSnapshot()).toMatchObject({ status: "error", url: null });
		handle.retry();
		expect(service.stats().inFlight).toBe(true);
	});

	it("new Worker 同步抛：不把异常抛给调用方，进错误态、不占 active、可重试", () => {
		let broken = true;
		const workers: FakeWorker[] = [];
		const { service } = fakeService({
			createWorker: () => {
				if (broken) throw new Error("Worker 被拦截");
				const worker = new FakeWorker();
				workers.push(worker);
				return worker as unknown as Worker;
			},
		});
		let acquired: ReturnType<typeof service.acquire> | null = null;
		expect(() => {
			acquired = service.acquire(image("blocked"));
		}).not.toThrow();
		if (!acquired) throw new Error("acquire 没返回句柄");
		const handle = acquired as ReturnType<typeof service.acquire>;
		expect(handle.getSnapshot().status).toBe("error");
		expect(service.stats()).toMatchObject({ inFlight: false, active: 0, syncFailures: 1, error: 1 });
		broken = false;
		handle.retry();
		expect(workerOf(workers).posted).toHaveLength(1);
		workerOf(workers).completeLast();
		expect(handle.getSnapshot().status).toBe("ready");
	});

	it("postMessage 同步抛：同样进错误态（不留 pending、可重试）", () => {
		const workers: FakeWorker[] = [];
		let throwOnPost = true;
		const { service } = fakeService({
			createWorker: () => {
				const worker = new FakeWorker();
				worker.throwOnPost = throwOnPost;
				workers.push(worker);
				return worker as unknown as Worker;
			},
		});
		const handle = service.acquire(image("post-throws"));
		expect(handle.getSnapshot().status).toBe("error");
		expect(service.stats()).toMatchObject({ inFlight: false, active: 0, syncFailures: 1 });
		// 修好后重试：重建的 worker 也应该正常（这里同时覆盖「同步失败后 worker 已被 dispose」）
		throwOnPost = false;
		handle.retry();
		expect(workerOf(workers).posted).toHaveLength(1);
	});

	it("批量同步失败不会递归爆栈：微任务收口，逐个停在错误态", async () => {
		const { service } = fakeService({
			createWorker: () => {
				throw new Error("Worker 被拦截");
			},
		});
		for (let index = 0; index < 60; index += 1)
			service.acquire(image(`blocked-${index}`), { visible: false });
		// 同步失败用微任务续跑（同一 tick 里不会递归进 pump），这里把微任务排空
		for (let index = 0; index < 200; index += 1) await Promise.resolve();
		expect(service.stats()).toMatchObject({ active: 0, inFlight: false, waiting: 0, idle: 0, error: 60 });
		expect(service.stats().syncFailures).toBe(60);
	});

	it("reset（切会话）：清队列与在途、revoke URL、清缓存，迟到结果不再影响任何状态", () => {
		const { service, worker, revokedUrls } = fakeService();
		const ready = service.acquire(image("done"));
		worker().completeLast();
		expect(ready.getSnapshot().status).toBe("ready");
		const inFlight = service.acquire(image("pending"));
		service.acquire(image("queued"), { visible: false });
		const requestId = lastRequestOf(worker()).requestId;

		service.reset();
		expect(service.stats()).toMatchObject({
			keys: 0,
			active: 0,
			waiting: 0,
			cacheEntries: 0,
			urls: 0,
			inFlight: false,
		});
		expect(revokedUrls).toHaveLength(1);
		expect(inFlight.getSnapshot()).toMatchObject({ status: "idle", url: null });
		worker().emit({
			requestId,
			ok: true,
			blob: new Blob([new Uint8Array(10)], { type: "image/png" }),
			width: 1,
			height: 1,
		});
		const next = service.acquire(image("next-session"));
		expect(next.getSnapshot().status).toBe("loading");
	});

	it("reset 换代：旧句柄不能碰新代资源（不能撤新 URL、不能改状态）", () => {
		const { service, worker, revokedUrls } = fakeService();
		const source = image("same-object");
		const stale = service.acquire(source);
		worker().completeLast();
		expect(stale.getSnapshot().status).toBe("ready");
		service.reset();

		const fresh = service.acquire(source);
		worker().completeLast();
		const freshSnapshot = fresh.getSnapshot();
		expect(freshSnapshot.status).toBe("ready");
		expect(revokedUrls.length).toBeGreaterThanOrEqual(1);
		const revokedBefore = revokedUrls.length;

		stale.release();
		stale.setVisible(false);
		stale.retry();
		expect(fresh.getSnapshot()).toEqual(freshSnapshot);
		expect(revokedUrls.length).toBe(revokedBefore);
		expect(service.stats().keys).toBe(1);
	});

	it("单飞：只有一个在途任务，完成一个才发下一个", () => {
		const { service, worker } = fakeService();
		service.acquire(image("q1"));
		service.acquire(image("q2"));
		service.acquire(image("q3"));
		expect(worker().posted).toHaveLength(1);
		worker().completeLast();
		expect(worker().posted).toHaveLength(2);
	});
});

describe("共享 IntersectionObserver（加载范围 vs 真实可视区）", () => {
	function setup() {
		const root = { id: "scroller" } as unknown as Element;
		const rects = new Map<Element, { top: number; bottom: number }>([[root, { top: 0, bottom: 800 }]]);
		const observed: Element[] = [];
		let callback: IntersectionObserverCallback | null = null;
		let init: IntersectionObserverInit | null = null;
		let disconnected = 0;
		let viewportSubscriptions = 0;
		let onViewportChange: (() => void) | null = null;
		const observer = {
			observe: (target: Element) => observed.push(target),
			unobserve: () => {},
			disconnect: () => {
				disconnected += 1;
			},
			root: null,
			rootMargin: "0px",
			thresholds: [],
			takeRecords: () => [],
		} as unknown as IntersectionObserver;
		return {
			root,
			rects,
			observed,
			init: () => init,
			disconnected: () => disconnected,
			viewportSubscriptions: () => viewportSubscriptions,
			triggerViewport: () => onViewportChange?.(),
			createObserver: (cb: IntersectionObserverCallback, options: IntersectionObserverInit) => {
				callback = cb;
				init = options;
				return observer;
			},
			subscribeViewportChange: (cb: () => void) => {
				viewportSubscriptions += 1;
				onViewportChange = cb;
				return () => {
					viewportSubscriptions -= 1;
					onViewportChange = null;
				};
			},
			readRect: (element: Element) => rects.get(element) ?? { top: 0, bottom: 0 },
			emitIntersection: (target: Element, isIntersecting: boolean) =>
				callback?.([{ target, isIntersecting } as unknown as IntersectionObserverEntry], observer),
		};
	}

	it("一个 root 只建一个 observer，root/rootMargin 按 spec 传下去", () => {
		const fake = setup();
		const observer = createHistoryImageObserver({
			root: fake.root,
			createObserver: fake.createObserver,
			subscribeViewportChange: fake.subscribeViewportChange,
			readRect: fake.readRect,
		});
		observer.observe({ id: "a" } as unknown as Element, () => {});
		observer.observe({ id: "b" } as unknown as Element, () => {});
		expect(observer.stats()).toEqual({ targets: 2, observers: 1, viewportSubscriptions: 1 });
		expect(fake.init()?.root).toBe(fake.root);
		expect(fake.init()?.rootMargin).toBe("400px 0px 400px 0px");
	});

	it("加载范围内 ≠ 真实可见：IO 命中后仍按几何区分，滚动时才升级为可见", () => {
		const fake = setup();
		const observer = createHistoryImageObserver({
			root: fake.root,
			createObserver: fake.createObserver,
			subscribeViewportChange: fake.subscribeViewportChange,
			readRect: fake.readRect,
		});
		const target = { id: "below" } as unknown as Element;
		// 在 400px 缓冲带里但落在可视区下方
		fake.rects.set(target, { top: 900, bottom: 1100 });
		const states: HistoryImageVisibility[] = [];
		observer.observe(target, (state) => states.push(state));
		fake.emitIntersection(target, true);
		expect(states.at(-1)).toEqual({ inLoadRange: true, inViewport: false });
		// 滚动后进入可视区
		fake.rects.set(target, { top: 100, bottom: 300 });
		fake.triggerViewport();
		expect(states.at(-1)).toEqual({ inLoadRange: true, inViewport: true });
		// 离开加载范围 → 两个标志都关
		fake.emitIntersection(target, false);
		expect(states.at(-1)).toEqual({ inLoadRange: false, inViewport: false });
	});

	it("同一元素重复订阅互不干扰；最后一个退订后整体断开（IO 与全局监听都不留）", () => {
		const fake = setup();
		const observer = createHistoryImageObserver({
			root: fake.root,
			createObserver: fake.createObserver,
			subscribeViewportChange: fake.subscribeViewportChange,
			readRect: fake.readRect,
		});
		const target = { id: "dup" } as unknown as Element;
		let firstCount = 0;
		let secondCount = 0;
		fake.rects.set(target, { top: 10, bottom: 20 });
		const stopFirst = observer.observe(target, () => {
			firstCount += 1;
		});
		const stopSecond = observer.observe(target, () => {
			secondCount += 1;
		});
		fake.emitIntersection(target, true);
		expect(firstCount).toBe(1);
		expect(secondCount).toBe(1);
		stopFirst();
		fake.emitIntersection(target, false);
		fake.emitIntersection(target, true);
		expect(firstCount).toBe(1);
		expect(secondCount).toBe(3);
		stopSecond();
		expect(observer.stats()).toEqual({ targets: 0, observers: 0, viewportSubscriptions: 0 });
		expect(fake.disconnected()).toBe(1);
		// 断开后再订阅会重建
		fake.rects.set(target, { top: 10, bottom: 20 });
		const stopAgain = observer.observe(target, () => {});
		expect(observer.stats()).toEqual({ targets: 1, observers: 1, viewportSubscriptions: 1 });
		stopAgain();
	});

	it("同一 root 复用同一个实例", () => {
		const root = { id: "shared-root" } as unknown as Element;
		const first = historyImageObserver(root, { createObserver: setup().createObserver });
		const second = historyImageObserver(root);
		expect(first).toBe(second);
	});
});
