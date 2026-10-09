/**
 * 历史图片的**共享**可见性观察（spec：一个 IO 服务同屏所有历史图，root 显式为当前 MessageList
 * 的滚动容器，rootMargin 上下各 400px）。
 *
 * 为什么要区分两件事：`inLoadRange`（IO + rootMargin，决定「要不要开始缩图」）与
 * `inViewport`（真实落在滚动容器可视区内，决定「谁优先、谁可以留在预算里」）。
 * 只有 IO 的 isIntersecting 会把 400px 缓冲带里的图当可见，可见优先就退化成先来先服务。
 *
 * 其余纪律：
 * - 同一元素重复订阅不许互相删除（一个元素可能被多个订阅者观察）→ 每个元素一个回调集合；
 * - 所有元素都退订时 `disconnect()`：断开 IO 并移除滚动/尺寸监听，不留下全局监听；
 * - 视口可见性只在**已进入加载范围的元素**上重算（滚动时不做全历史扫描），用滚动/尺寸事件 + rAF 合帧；
 *   注意：滚动容器自身尺寸变化（Composer 长高、侧栏开合）不一定伴随 window resize —— 阶段 3 接线 root 时
 *   要加一个共享 ResizeObserver 观察 root，变化时触发同一条 refresh（本文件已把 refresh 收在一处，接得上）；
 * - `disconnect` 是 owner 级拆除（比如列表卸载），组件只调用自己 `observe` 返回的 stop。
 */
import { VIEWPORT_ROOT_MARGIN_PX } from "./constants";

export interface HistoryImageVisibility {
	/** 在加载范围内（IO + rootMargin）：可以开始缩图 */
	inLoadRange: boolean;
	/** 真实落在滚动容器可视区内：可见优先的依据 */
	inViewport: boolean;
}

export interface HistoryImageObserver {
	/** 返回取消订阅函数（组件用自己的 stop 退订；`disconnect` 留给 owner 销毁时整体拆除） */
	observe(target: Element, onChange: (state: HistoryImageVisibility) => void): () => void;
	disconnect(): void;
	stats(): { targets: number; observers: number; viewportSubscriptions: number };
}

export interface HistoryImageObserverOptions {
	root: Element;
	rootMarginPx?: number;
	/** 只为单测注入；生产走全局 IntersectionObserver */
	createObserver?: (
		callback: IntersectionObserverCallback,
		options: IntersectionObserverInit,
	) => IntersectionObserver;
	/** 只为单测注入：监听「可能改变可视区」的事件（滚动/尺寸），返回取消函数 */
	subscribeViewportChange?: (onChange: () => void) => () => void;
	/** 只为单测注入：几何读取 */
	readRect?: (element: Element) => { top: number; bottom: number };
}

interface TargetRecord {
	callbacks: Set<(state: HistoryImageVisibility) => void>;
	inLoadRange: boolean;
	inViewport: boolean;
}

export function createHistoryImageObserver(options: HistoryImageObserverOptions): HistoryImageObserver {
	const margin = options.rootMarginPx ?? VIEWPORT_ROOT_MARGIN_PX;
	const createObserver =
		options.createObserver ?? ((callback, init) => new IntersectionObserver(callback, init));
	const readRect =
		options.readRect ??
		((element: Element) => element.getBoundingClientRect() as DOMRect as { top: number; bottom: number });
	const targets = new Map<Element, TargetRecord>();
	let observer: IntersectionObserver | null = null;
	let unsubscribeViewport: (() => void) | null = null;

	function subscribeViewportChange(onChange: () => void): () => void {
		if (options.subscribeViewportChange) return options.subscribeViewportChange(onChange);
		let frame = 0;
		const schedule = () => {
			if (frame) return;
			frame = requestAnimationFrame(() => {
				frame = 0;
				onChange();
			});
		};
		options.root.addEventListener("scroll", schedule, { passive: true });
		window.addEventListener("resize", schedule, { passive: true });
		return () => {
			if (frame) cancelAnimationFrame(frame);
			options.root.removeEventListener("scroll", schedule);
			window.removeEventListener("resize", schedule);
		};
	}

	function isInViewport(target: Element): boolean {
		const rect = readRect(target);
		const rootRect = readRect(options.root);
		return rect.top < rootRect.bottom && rect.bottom > rootRect.top;
	}

	function emit(_target: Element, record: TargetRecord): void {
		const state: HistoryImageVisibility = {
			inLoadRange: record.inLoadRange,
			inViewport: record.inViewport,
		};
		for (const callback of [...record.callbacks]) callback(state);
	}

	/** 只在「已进入加载范围」的元素上重算真实可见性（不做全历史扫描） */
	function refreshViewport(): void {
		for (const [target, record] of targets) {
			if (!record.inLoadRange) continue;
			const next = isInViewport(target);
			if (next === record.inViewport) continue;
			record.inViewport = next;
			emit(target, record);
		}
	}

	function ensureObserver(): IntersectionObserver {
		if (observer) return observer;
		observer = createObserver(
			(entries) => {
				for (const entry of entries) {
					const record = targets.get(entry.target);
					if (!record) continue;
					const inLoadRange = entry.isIntersecting;
					const inViewport = inLoadRange ? isInViewport(entry.target) : false;
					if (record.inLoadRange === inLoadRange && record.inViewport === inViewport) continue;
					record.inLoadRange = inLoadRange;
					record.inViewport = inViewport;
					emit(entry.target, record);
				}
			},
			{
				root: options.root,
				rootMargin: `${margin}px 0px ${margin}px 0px`,
				threshold: 0,
			},
		);
		if (!unsubscribeViewport) unsubscribeViewport = subscribeViewportChange(refreshViewport);
		return observer;
	}

	function disconnect(): void {
		observer?.disconnect();
		observer = null;
		unsubscribeViewport?.();
		unsubscribeViewport = null;
		targets.clear();
	}

	return {
		observe: (target: Element, onChange: (state: HistoryImageVisibility) => void) => {
			let record = targets.get(target);
			if (!record) {
				record = { callbacks: new Set(), inLoadRange: false, inViewport: false };
				targets.set(target, record);
				ensureObserver().observe(target);
			}
			const current = record;
			current.callbacks.add(onChange);
			// 新订阅者立刻拿到**当前已知状态**（含 false/false 初态）：否则在没有任何 scroll/resize/IO
			// 边界变化时，第二个订阅者会一直停在默认 false 上（阶段 3 同元素换图/重订阅会卡在占位）。
			// 只投递给新订阅者，不为初始化它去通知别人，也不重建 IO。
			onChange({ inLoadRange: current.inLoadRange, inViewport: current.inViewport });
			return () => {
				const existing = targets.get(target);
				if (!existing) return;
				existing.callbacks.delete(onChange);
				if (existing.callbacks.size > 0) return;
				observer?.unobserve(target);
				targets.delete(target);
				// 没有观察对象了就整体断开，别留 IO 与全局监听
				if (targets.size === 0) disconnect();
			};
		},
		disconnect,
		stats: () => ({
			targets: targets.size,
			observers: observer ? 1 : 0,
			viewportSubscriptions: unsubscribeViewport ? 1 : 0,
		}),
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
