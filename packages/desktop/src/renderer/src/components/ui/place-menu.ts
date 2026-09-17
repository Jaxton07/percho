/** 浮层锚点：触发元素在**视口坐标**下的矩形（getBoundingClientRect 直接映射 MenuAnchor） */
export interface MenuAnchor {
	left: number;
	top: number;
	width: number;
	height: number;
}

export interface MenuSize {
	width: number;
	height: number;
}

export interface ViewportSize {
	width: number;
	height: number;
}

interface PlaceOptions {
	/** 浮层与触发元素的垂直间距（菜单 4px / 重命名浮层 8px） */
	gap?: number;
	/** 贴视口边缘的最小内边距 */
	margin?: number;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), Math.max(min, max));
}

/** 触发元素的视口矩形 → 浮层锚点（各处 contextmenu 处理器统一入口） */
export function anchorOfElement(el: Element): MenuAnchor {
	const rect = el.getBoundingClientRect();
	return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

/**
 * 右键菜单/重命名浮层定位（纯函数，可单测）：锚在触发元素**下沿左对齐**；
 * 右侧放不下 → 左翻（浮层右缘贴触发元素右缘）；下方放不下且上方够 → 上翻；
 * 最后统一夹进视口内边距，保证任何窗口尺寸下都可见。
 */ export function placeMenu(
	anchor: MenuAnchor,
	size: MenuSize,
	viewport: ViewportSize,
	{ gap = 4, margin = 6 }: PlaceOptions = {},
): { x: number; y: number } {
	const below = anchor.top + anchor.height + gap;
	const above = anchor.top - gap - size.height;
	const y = below + size.height > viewport.height - margin && above >= margin ? above : below;
	const leftAligned = anchor.left;
	const flipped = leftAligned + size.width > viewport.width - margin;
	const x = flipped ? anchor.left + anchor.width - size.width : leftAligned;
	return {
		x: clamp(x, margin, viewport.width - size.width - margin),
		y: clamp(y, margin, viewport.height - size.height - margin),
	};
}
