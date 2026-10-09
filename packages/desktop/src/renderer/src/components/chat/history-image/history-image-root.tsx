import { createContext, type ReactNode, useContext } from "react";

/**
 * 历史图片的**私有 root**：当前 MessageList 的滚动容器。
 *
 * 为什么用 context 而不是全局单例：多会话/多列表同时存在时 root 必须跟着列表走；
 * 而且**拿不到 root 时必须退化成「不加载」**（占位），绝不能默认成「可见」——
 * 否则列表没接 root 的场景会全量缩图，把预算用光。
 */
const HistoryImageRootContext = createContext<Element | null>(null);

export function HistoryImageRootProvider({ root, children }: { root: Element | null; children: ReactNode }) {
	return <HistoryImageRootContext.Provider value={root}>{children}</HistoryImageRootContext.Provider>;
}

/** 返回 null = 还没接线（组件据此只渲染同尺寸占位，不做任何加载） */
export function useHistoryImageRoot(): Element | null {
	return useContext(HistoryImageRootContext);
}
