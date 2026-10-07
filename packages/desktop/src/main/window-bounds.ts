import type { Rect } from "@percho/shared";

/**
 * 窗口位置/尺寸的尺寸契约 +「上次那扇窗还在不在屏幕上」的纯函数校验。
 *
 * **本模块不 import electron**：`workArea` 由调用方（`main/index.ts`）从 `screen.getAllDisplays()` 取好传进来
 * —— 这样才能在 vitest 里无 mock 地测拔屏/换小屏场景（本机只有一块屏，测不了）。
 */

/** 没记过 bounds 时的默认尺寸（也是现行为，改动需同步 spec） */
export const WINDOW_DEFAULT_WIDTH = 1100;
export const WINDOW_DEFAULT_HEIGHT = 750;
/** 最小尺寸 = `BrowserWindow` 的 minWidth/minHeight（用户拖不到更小） */
export const WINDOW_MIN_WIDTH = 640;
export const WINDOW_MIN_HEIGHT = 480;
/** 窗口与所选屏幕 workArea 的最小交集：两个方向都不小于它才算「这块屏上还看得见」 */
export const BOUNDS_MIN_VISIBLE_W = 160;
export const BOUNDS_MIN_VISIBLE_H = 80;
/** bounds 落盘防抖：拖动途中 resize/move 每帧都来，不能每帧写盘 */
export const BOUNDS_SAVE_DEBOUNCE_MS = 400;

function isFiniteRect(rect: Rect): boolean {
	return (
		Number.isFinite(rect.x) &&
		Number.isFinite(rect.y) &&
		Number.isFinite(rect.width) &&
		Number.isFinite(rect.height)
	);
}

function overlapSize(a: Rect, b: Rect): { width: number; height: number; area: number } {
	const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
	const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
	return { width, height, area: width * height };
}

/**
 * 校验并夹紧持久化的窗口 bounds（spec §5.4 行为契约）：
 * 1. `raw` 为空 / 没有任何屏幕 / 字段非有限数 → `null`（调用方走默认尺寸与系统摆放）；
 * 2. 选**交集面积最大**的那块 workArea（等价 `screen.getDisplayMatching` 的意图：最接近相交的那块屏）；
 * 3. 与它的交集宽 < `BOUNDS_MIN_VISIBLE_W` 或高 < `BOUNDS_MIN_VISIBLE_H` → `null`（拔屏/屏幕挪走了）；
 * 4. 宽高超过该 workArea → 夹到 workArea 的宽高（大屏换小屏）；
 * 5. 平移，使窗口完整落在该 workArea 内（x/y 各自夹进合法区间）；
 * 6. 返回夹紧后的整数矩形（`x` 可以为负 —— 左侧副屏是合法的）。
 */
export function sanitizeWindowBounds(raw: Rect | null, workAreas: Rect[]): Rect | null {
	if (!raw || !isFiniteRect(raw) || workAreas.length === 0) return null;

	let target: Rect | null = null;
	let bestOverlap = 0;
	for (const workArea of workAreas) {
		if (!isFiniteRect(workArea)) continue;
		const overlap = overlapSize(raw, workArea);
		if (overlap.area > bestOverlap) {
			bestOverlap = overlap.area;
			target = workArea;
		}
	}
	if (!target) return null;

	const overlap = overlapSize(raw, target);
	if (overlap.width < BOUNDS_MIN_VISIBLE_W || overlap.height < BOUNDS_MIN_VISIBLE_H) return null;

	const width = Math.round(Math.min(raw.width, target.width));
	const height = Math.round(Math.min(raw.height, target.height));
	const x = Math.round(Math.min(Math.max(raw.x, target.x), target.x + target.width - width));
	const y = Math.round(Math.min(Math.max(raw.y, target.y), target.y + target.height - height));
	return { x, y, width, height };
}
