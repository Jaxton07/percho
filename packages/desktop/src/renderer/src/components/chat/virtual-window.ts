import type { RowPositions } from "./row-positions";

/** 视口上下各多渲染的像素（快速滚动不露白、视口上方行的高度变化仍由原生锚定吸收） */
export const OVERSCAN_PX = 1200;
/** 渲染行硬上限：DOM 不随会话长度增长 */
export const MAX_RENDERED_ROWS = 120;

/**
 * 由滚动位置求渲染区间 [start, end)。
 * following 时锁尾：流式输出只增长末行，窗口跟着尾部走。
 * 行太小导致超过上限时，以视口首行为中心截断，保证视口内的行一定在区间里。
 */
export function windowFor(
	positions: RowPositions,
	scrollTop: number,
	viewport: number,
	following: boolean,
): { start: number; end: number } {
	const count = positions.count;
	if (count === 0) return { start: 0, end: 0 };
	const total = positions.total();
	// 滚动位置可能来自上一份更长的内容（切会话、重载后还没收到 scroll 事件）：按浏览器同样的规则夹到可滚范围
	const maxTop = Math.max(0, total - viewport);
	const top = following ? maxTop : Math.min(maxTop, Math.max(0, scrollTop));
	let start = positions.indexAt(top - OVERSCAN_PX);
	let end = following ? count : Math.min(count, positions.indexAt(top + viewport + OVERSCAN_PX) + 1);
	if (end - start > MAX_RENDERED_ROWS) {
		const first = positions.indexAt(top);
		const last = Math.min(count, positions.indexAt(top + viewport) + 1);
		const extra = Math.max(0, MAX_RENDERED_ROWS - (last - first));
		start = Math.max(start, first - Math.floor(extra / 2));
		end = Math.min(end, start + MAX_RENDERED_ROWS);
		start = Math.max(0, end - MAX_RENDERED_ROWS);
	}
	return { start, end };
}
