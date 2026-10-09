/**
 * 「一张历史图 ↔ 资源服务 + 可见性观察」的**纯接线**（无 React）：组件只在 effect 里建它、在 cleanup 里销毁它。
 *
 * 三条纪律都由这里保证（也是单测能直接钉住的部分）：
 * 1. **不在 render 里 acquire**：创建时机由调用方（effect）决定；
 * 2. **初始可见性必须是 false**：真实可见性只能由观察者回调给出，绝不默认 visible=true；
 * 3. **没有 root / 观察者时什么都不加载**：只留同尺寸占位。
 */
import type { ImageInput } from "@percho/shared";
import type { HistoryImageObserver } from "./history-image-observer";
import type { ThumbnailHandle, ThumbnailService, ThumbnailSnapshot } from "./history-image-service";

export interface HistoryImageBinding {
	getSnapshot(): ThumbnailSnapshot;
	subscribe(listener: () => void): () => void;
	retry(): void;
	dispose(): void;
}

export interface HistoryImageBindingOptions {
	service: ThumbnailService;
	image: ImageInput;
	/** 观察目标（外盒元素） */
	element: Element | null;
	/** 共享观察者；与 element 同时具备才会建立可见性订阅 */
	observer: HistoryImageObserver | null;
}

const INERT: ThumbnailSnapshot = { status: "idle", url: null, width: null, height: null };

export function createHistoryImageBinding(options: HistoryImageBindingOptions): HistoryImageBinding {
	const { service, image, element, observer } = options;
	const handle: ThumbnailHandle = service.acquire(image, { visible: false });
	const stopObserving =
		element && observer
			? observer.observe(element, (state) => {
					// 只有真实落在滚动容器可视区内才算可见；加载范围内但不可见只是「可以开始缩图」
					handle.setVisible(state.inViewport);
				})
			: null;

	let disposed = false;
	return {
		getSnapshot: () => (disposed ? INERT : handle.getSnapshot()),
		subscribe: (listener: () => void) => (disposed ? () => {} : handle.subscribe(listener)),
		retry: () => {
			if (!disposed) handle.retry();
		},
		dispose: () => {
			if (disposed) return;
			disposed = true;
			stopObserving?.();
			handle.release();
		},
	};
}

/** 没有接线（无 root）时的常量快照：保证 useSyncExternalStore 拿到稳定引用 */
export const INERT_SNAPSHOT: ThumbnailSnapshot = INERT;
