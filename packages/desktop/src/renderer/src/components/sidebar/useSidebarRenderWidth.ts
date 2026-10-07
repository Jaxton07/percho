import type { RefObject } from "react";
import { useLayoutEffect, useState } from "react";
import { sidebarRenderWidth } from "../../lib/sidebar-width";

/** 元素**内容盒**宽（百分比宽度的解析基准）：`clientWidth` 含内边距，要减掉才与 ResizeObserver 的 contentRect 同口径 */
function contentWidth(el: HTMLElement): number {
	const style = getComputedStyle(el);
	return el.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
}

/**
 * 测侧栏所在 flex 容器的宽，与用户意图值一起派生出**渲染宽**（`lib/sidebar-width.ts`）。
 *
 * 为什么需要 JS 而不是纯 CSS：外层 `width: min(var(--sidebar-width), calc(100% - 320px))` 只能夹住外层自己，
 * **内层拿不到外层的计算宽**（`100%` 在内层解析的是外层那已经夹过的宽，会连环缩小），而 push 式折叠动画
 * 又要求内层是「当前这一档的固定宽」——所以渲染宽只能算一次、喂给内外两层（REVIEW R1）。
 *
 * 容器宽用 ResizeObserver 跟（窗口缩放 / 全屏 / 分屏都在内）；用 `useLayoutEffect` 让首帧就拿到正确值，
 * 避免窄窗启动时先按用户值渲染一帧再把内层裁掉。
 */
export function useSidebarRenderWidth(userWidth: number, asideRef: RefObject<HTMLElement | null>): number {
	const [containerWidth, setContainerWidth] = useState(0);

	useLayoutEffect(() => {
		const container = asideRef.current?.parentElement;
		if (!container) return;
		setContainerWidth(contentWidth(container));
		const observer = new ResizeObserver((entries) => {
			const entry = entries[0];
			if (entry) setContainerWidth(entry.contentRect.width);
		});
		observer.observe(container);
		return () => observer.disconnect();
	}, [asideRef]);

	return sidebarRenderWidth(userWidth, containerWidth);
}
