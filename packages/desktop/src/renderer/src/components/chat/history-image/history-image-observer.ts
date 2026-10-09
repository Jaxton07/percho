/**
 * 历史图片的**共享** IntersectionObserver（spec：一个 IO 服务同屏所有历史图，root 显式为
 * 当前 MessageList 的滚动容器，rootMargin 上下各 400px）。
 *
 * 为什么必须显式 root：历史图在 `.chat-scrollbar` 这个内层滚动容器里，用默认 root（视口）
 * 会算错触发时机；用「每个组件一个 observer」则是典型的 N 个实例放大开销。
 */
import { VIEWPORT_ROOT_MARGIN_PX } from "./constants";

export interface HistoryImageObserver {
	/** 返回取消订阅函数 */
	observe(target: Element, onChange: (visible: boolean) => void): () => void;
	disconnect(): void;
	stats(): { elements: number; observers: number };
}

export interface HistoryImageObserverOptions {
	root: Element;
	rootMarginPx?: number;
	/** 只为单测注入；生产走全局 IntersectionObserver */
	createObserver?: (
		callback: IntersectionObserverCallback,
		options: IntersectionObserverInit,
	) => IntersectionObserver;
}

export function createHistoryImageObserver(options: HistoryImageObserverOptions): HistoryImageObserver {
	const margin = options.rootMarginPx ?? VIEWPORT_ROOT_MARGIN_PX;
	const createObserver =
		options.createObserver ?? ((callback, init) => new IntersectionObserver(callback, init));
	const callbacks = new Map<Element, (visible: boolean) => void>();
	let observer: IntersectionObserver | null = null;

	function ensureObserver(): IntersectionObserver {
		if (observer) return observer;
		observer = createObserver(
			(entries) => {
				for (const entry of entries) {
					const notify = callbacks.get(entry.target);
					if (notify) notify(entry.isIntersecting);
				}
			},
			{
				root: options.root,
				rootMargin: `${margin}px 0px ${margin}px 0px`,
				threshold: 0,
			},
		);
		return observer;
	}

	return {
		observe: (target: Element, onChange: (visible: boolean) => void) => {
			callbacks.set(target, onChange);
			ensureObserver().observe(target);
			return () => {
				callbacks.delete(target);
				observer?.unobserve(target);
			};
		},
		disconnect: () => {
			observer?.disconnect();
			observer = null;
			callbacks.clear();
		},
		stats: () => ({ elements: callbacks.size, observers: observer ? 1 : 0 }),
	};
}

const shared = new WeakMap<Element, HistoryImageObserver>();

/** 同一个滚动容器共享一个 observer（App 级）；root 换了（切会话重建列表）自然拿到新的 */
export function historyImageObserver(
	root: Element,
	options: { createObserver?: HistoryImageObserverOptions["createObserver"] } = {},
): HistoryImageObserver {
	const existing = shared.get(root);
	if (existing) return existing;
	const created = createHistoryImageObserver({ root, ...options });
	shared.set(root, created);
	return created;
}
