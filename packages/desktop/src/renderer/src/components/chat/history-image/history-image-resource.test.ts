import type { ImageInput } from "@percho/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ACTIVE_SLOT_LIMIT,
	CACHE_BYTE_LIMIT,
	TASK_TIMEOUT_MS,
	THUMBNAIL_MAX_SIDE,
	WAITING_LIMIT,
} from "./constants";
import { createHistoryImageObserver, historyImageObserver } from "./history-image-observer";
import { createThumbnailService } from "./history-image-service";
import { ActiveSlotRegistry, ThumbnailCache } from "./thumbnail-budget";
import type { ThumbnailRequest, ThumbnailResponse } from "./thumbnail-protocol";

const image = (seed: string): ImageInput => ({ mimeType: "image/png", data: `data-${seed}` });

class FakeWorker {
	posted: ThumbnailRequest[] = [];
	terminated = 0;
	private messageListeners: ((event: { data: ThumbnailResponse }) => void)[] = [];
	private errorListeners: (() => void)[] = [];

	postMessage(request: ThumbnailRequest): void {
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

function fakeService(options: { timeoutMs?: number } = {}) {
	const workers: FakeWorker[] = [];
	const createdUrls: string[] = [];
	const revokedUrls: string[] = [];
	const service = createThumbnailService({
		createWorker: () => {
			const worker = new FakeWorker();
			workers.push(worker);
			return worker as unknown as Worker;
		},
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
	it("活跃 slot 上限：满了就没有下一个任务，也不占更多资源", () => {
		const registry = new ActiveSlotRegistry({ active: 2, waiting: 8 });
		for (let key = 1; key <= 4; key += 1) registry.subscribe(key, "visible");
		expect(registry.hasSlot()).toBe(true);
		const first = registry.nextWaiting();
		expect(first).not.toBeNull();
		registry.setState(first as number, "loading");
		registry.setState(registry.nextWaiting() as number, "ready");
		expect(registry.activeCount()).toBe(2);
		expect(registry.hasSlot()).toBe(false);
	});

	it("等待队列上限：超出的缓冲项降级为 idle，之后有空位会被放回", () => {
		const registry = new ActiveSlotRegistry({ active: 10, waiting: 3 });
		for (let key = 1; key <= 5; key += 1) registry.subscribe(key, "buffer");
		expect(registry.waitingCount()).toBe(3);
		expect(registry.idleCount()).toBe(2);
		// 队列腾出一个位置（比如一个任务开始跑）
		registry.setState(1, "loading");
		expect(registry.promoteIdle()).toBe(1);
		expect(registry.waitingCount()).toBe(3);
		expect(registry.idleCount()).toBe(1);
	});

	it("可见优先：后到的可见请求排在被缓冲项前面", () => {
		const registry = new ActiveSlotRegistry({ active: 8, waiting: 8 });
		registry.subscribe(1, "buffer");
		registry.subscribe(2, "buffer");
		registry.subscribe(3, "visible");
		expect(registry.nextWaiting()).toBe(3);
	});

	it("可见不被饿死：队列满时挤掉最老的缓冲项而不是拒绝可见请求", () => {
		const registry = new ActiveSlotRegistry({ active: 8, waiting: 2 });
		registry.subscribe(1, "buffer");
		registry.subscribe(2, "buffer");
		expect(registry.waitingCount()).toBe(2);
		registry.subscribe(3, "visible");
		expect(registry.waitingCount()).toBe(2);
		expect(registry.nextWaiting()).toBe(3);
		expect(registry.state(1)).toBe("idle");
	});

	it("队列满时降级的必须是最老的缓冲项：可见项即使更早入队也不许被降级", () => {
		const registry = new ActiveSlotRegistry({ active: 8, waiting: 2 });
		registry.subscribe(1, "visible"); // seq 1，可见
		registry.subscribe(2, "buffer"); // seq 2，缓冲
		registry.subscribe(3, "buffer"); // 队列满 → 先落 idle
		// 第 3 个变可见要插队 → 队列超上限 → 该降级的是「最老的缓冲项」(2)，不能是更早的可见项 (1)
		registry.setVisibility(3, "visible");
		expect(registry.state(1)).toBe("waiting");
		expect(registry.visibility(1)).toBe("visible");
		expect(registry.state(2)).toBe("idle");
		expect(registry.nextWaiting()).toBe(1);
	});

	it("同 key 多订阅者只算一次资源需求；全部退订才算释放", () => {
		const registry = new ActiveSlotRegistry();
		registry.subscribe(7, "visible");
		registry.subscribe(7, "buffer");
		expect(registry.waitingCount()).toBe(1);
		expect(registry.subscribers(7)).toBe(2);
		expect(registry.unsubscribe(7)).toBe(false);
		expect(registry.unsubscribe(7)).toBe(true);
		expect(registry.stats().keys).toBe(0);
	});

	it("任一订阅者可见即视为可见（后订阅的缓冲不能把可见降级）", () => {
		const registry = new ActiveSlotRegistry();
		registry.subscribe(9, "visible");
		registry.subscribe(9, "buffer");
		expect(registry.visibility(9)).toBe("visible");
	});

	it("失败项可重试（requeue 回到队列）", () => {
		const registry = new ActiveSlotRegistry();
		registry.subscribe(11, "visible");
		registry.setState(11, "error");
		expect(registry.stats().error).toBe(1);
		registry.requeue(11);
		expect(registry.state(11)).toBe("waiting");
		expect(registry.stats().error).toBe(0);
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
		const { service, worker, createdUrls } = fakeService();
		const source = image("a");
		const handle = service.acquire(source);
		expect(handle.getSnapshot().status).toBe("loading");
		expect(worker().posted).toHaveLength(1);
		expect(worker().lastRequest?.image).toBe(source);
		expect(worker().lastRequest?.maxSide).toBe(384);
		worker().completeLast();
		expect(handle.getSnapshot()).toMatchObject({ status: "ready", width: 384, height: 240 });
		expect(createdUrls).toHaveLength(1);
		expect(handle.getSnapshot().url).toBe(createdUrls[0]);
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
		const a = image("same-content");
		const b = image("same-content");
		expect(a).not.toBe(b);
		service.acquire(a);
		service.acquire(b);
		// 单飞：第一条在途，第二条在队列里
		expect(worker().posted).toHaveLength(1);
		worker().completeLast();
		expect(worker().posted).toHaveLength(2);
	});

	it("可见性变化：调度顺序上「可见」插到「缓冲」前面（已经在跑的那张不抢占）", () => {
		const { service, worker } = fakeService();
		service.acquire(image("buffer-1"), { visible: false });
		service.acquire(image("buffer-2"), { visible: false });
		const visible = service.acquire(image("visible"));
		// 单飞：在途的那张不会被抢占，所以第一条一定是 buffer-1
		expect(worker().posted).toHaveLength(1);
		expect(worker().lastRequest?.image.data).toBe("data-buffer-1");
		worker().completeLast();
		// 下一张该跑的是可见项，而不是更早入队的 buffer-2
		expect(worker().posted).toHaveLength(2);
		expect(worker().lastRequest?.image.data).toBe("data-visible");
		expect(visible.getSnapshot().status).toBe("loading");
	});
});

describe("缩略图服务：取消 / 迟到 / 超时 / 重置", () => {
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
		expect(service.stats().inFlight).toBe(true);
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
		// 旧任务的响应回来：没有订阅者 → 丢掉，但队列照常推进（B 被派发）
		worker().emit(staleResponse(staleRequestId));
		const fresh = service.acquire(image("fresh"));
		expect(worker().posted).toHaveLength(2);
		expect(fresh.getSnapshot().status).toBe("loading");
		// 同一条旧响应再投递一次（重复/迟到的第二次），此时在途的是 B —— 绝不能算到 B 头上
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
		// 重试：懒重建 worker 再跑一次
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

	it("reset（切会话）：清队列与在途、revoke URL、清缓存，迟到结果不再影响任何状态", () => {
		const { service, worker, revokedUrls } = fakeService();
		const ready = service.acquire(image("done"));
		worker().completeLast();
		expect(ready.getSnapshot().status).toBe("ready");
		const inFlight = service.acquire(image("pending"));
		service.acquire(image("queued"), { visible: false });
		const requestId = lastRequestOf(worker()).requestId;
		expect(service.stats().inFlight).toBe(true);

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
		expect(ready.getSnapshot()).toMatchObject({ status: "idle", url: null });
		expect(inFlight.getSnapshot().status).toBe("idle");

		// 迟到消息：不该抛，也不该把状态改回去
		worker().emit({
			requestId,
			ok: true,
			blob: new Blob([new Uint8Array(10)], { type: "image/png" }),
			width: 1,
			height: 1,
		});
		expect(ready.getSnapshot().status).toBe("idle");
		// reset 之后还能继续用（新会话懒重建 worker）
		const next = service.acquire(image("next-session"));
		expect(next.getSnapshot().status).toBe("loading");
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

	it("缓冲请求超过队列上限：等待队列不超过 48，其余降级，有空位会补上", () => {
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

describe("共享 IntersectionObserver", () => {
	function fakeObserver() {
		const observed: Element[] = [];
		let callback: IntersectionObserverCallback | null = null;
		let options: IntersectionObserverInit | null = null;
		let disconnected = 0;
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
			createObserver: (cb: IntersectionObserverCallback, init: IntersectionObserverInit) => {
				callback = cb;
				options = init;
				return observer;
			},
			emit: (target: Element, isIntersecting: boolean) =>
				callback?.([{ target, isIntersecting } as unknown as IntersectionObserverEntry], observer),
			observed,
			observedOptions: () => options,
			disconnected: () => disconnected,
		};
	}

	it("一个 root 只建一个 observer，root 与 rootMargin 按 spec 传下去", () => {
		const fake = fakeObserver();
		const root = { id: "scroller" } as unknown as Element;
		const observer = createHistoryImageObserver({ root, createObserver: fake.createObserver });
		const target = { id: "img" } as unknown as Element;
		observer.observe(target, () => {});
		observer.observe({ id: "img2" } as unknown as Element, () => {});
		expect(observer.stats()).toEqual({ elements: 2, observers: 1 });
		expect(fake.observedOptions()?.root).toBe(root);
		expect(fake.observedOptions()?.rootMargin).toBe("400px 0px 400px 0px");
	});

	it("可见性回调按元素分发；取消订阅后不再回调", () => {
		const fake = fakeObserver();
		const root = { id: "scroller" } as unknown as Element;
		const observer = createHistoryImageObserver({ root, createObserver: fake.createObserver });
		const seen: boolean[] = [];
		const target = { id: "img" } as unknown as Element;
		const stop = observer.observe(target, (visible) => seen.push(visible));
		fake.emit(target, true);
		fake.emit(target, false);
		expect(seen).toEqual([true, false]);
		stop();
		fake.emit(target, true);
		expect(seen).toEqual([true, false]);
	});

	it("同一 root 复用同一个实例", () => {
		const root = { id: "shared-root" } as unknown as Element;
		const first = historyImageObserver(root, { createObserver: fakeObserver().createObserver });
		const second = historyImageObserver(root);
		expect(first).toBe(second);
	});
});
