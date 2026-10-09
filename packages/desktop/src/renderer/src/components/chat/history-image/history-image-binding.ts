/**
 * 「一张历史图 ↔ 资源服务 + 可见性观察」的**纯接线**（无 React）：组件只在 effect 里建它、在 cleanup 里销毁它。
 *
 * 硬契约（spec「只加载加载区内的图」）：
 * 1. **创建时只观察、不 acquire**：没有 element/observer 就彻底惰性（一个请求都不发）；
 * 2. **进入 inLoadRange 才 acquire(image, { visible: inViewport })** —— 默认可见性永远来自观察者，
 *    绝不用 `visible=true` 兜底；
 * 3. **离开 inLoadRange 立即退订并 release**（撤 URL、还 slot、丢未执行需求；已经派出去的那一张
 *    允许在途完成，但结果按 token 丢弃）；
 * 4. 绑定层自己维护订阅集合：没有 handle 时 `useSyncExternalStore` 仍能订阅（拿到稳定的惰性快照）。
 *
 * 为什么不是「先 acquire 再 setVisible(false)」：service 的 buffer 请求照样会被调度（只是优先级低），
 * 那就是「全量挂载 + 保 48 张」，不是加载区门；实测会被 reviewer 的用例抓住（posted 立即 ≥1）。
 */
import type { ImageInput } from "@percho/shared";
import type { HistoryImageObserver } from "./history-image-observer";
import type { ThumbnailHandle, ThumbnailService, ThumbnailSnapshot } from "./history-image-service";

/** 无 handle 时对外暴露的稳定惰性快照（引用恒定，避免无变化重渲染） */
export const INERT_SNAPSHOT: ThumbnailSnapshot = { status: "idle", url: null, width: null, height: null };

export interface HistoryImageBinding {
	getSnapshot(): ThumbnailSnapshot;
	subscribe(listener: () => void): () => void;
	/** 错误态可重试（只在持有 handle 时有效；不在加载区时是 no-op） */
	retry(): void;
	dispose(): void;
}

export interface HistoryImageBindingOptions {
	service: ThumbnailService;
	image: ImageInput;
	/** 观察目标（外盒元素）；为 null 时彻底惰性 */
	element: Element | null;
	/** 共享观察者；为 null 时彻底惰性 */
	observer: HistoryImageObserver | null;
}

export function createHistoryImageBinding(options: HistoryImageBindingOptions): HistoryImageBinding {
	const { service, image, element, observer } = options;
	const listeners = new Set<() => void>();
	let handle: ThumbnailHandle | null = null;
	let unsubscribeHandle: (() => void) | null = null;
	let inLoadRange = false;
	let inViewport = false;
	let disposed = false;

	function notify(): void {
		for (const listener of [...listeners]) {
			try {
				listener();
			} catch {
				// 渲染层回调异常不能打断接线内务
			}
		}
	}

	/** 离开加载区：先解绑监听再 release（撤 URL / 还 slot / 丢未执行需求） */
	function releaseHandle(): void {
		unsubscribeHandle?.();
		unsubscribeHandle = null;
		handle?.release();
		handle = null;
	}

	function acquireHandle(): void {
		if (disposed || handle) return;
		const created = service.acquire(image, { visible: inViewport });
		handle = created;
		unsubscribeHandle = created.subscribe(() => {
			// handle 变了就转发给自己的订阅者；释放过程中到达的通知不再转发
			if (handle === created) notify();
		});
	}

	function applyState(next: { inLoadRange: boolean; inViewport: boolean }): void {
		if (disposed) return;
		const wasInRange = inLoadRange;
		inLoadRange = next.inLoadRange;
		inViewport = next.inViewport;
		if (!inLoadRange) {
			releaseHandle();
			if (wasInRange) notify();
			return;
		}
		if (!handle) {
			acquireHandle();
			notify();
			return;
		}
		handle.setVisible(inViewport);
		notify();
	}

	const stopObserving =
		element && observer
			? observer.observe(element, (state) => {
					applyState(state);
				})
			: null;

	return {
		getSnapshot: () => (disposed || !handle ? INERT_SNAPSHOT : handle.getSnapshot()),
		subscribe: (listener: () => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		retry: () => {
			if (disposed) return;
			handle?.retry();
		},
		dispose: () => {
			if (disposed) return;
			disposed = true;
			stopObserving?.();
			releaseHandle();
			listeners.clear();
		},
	};
}
