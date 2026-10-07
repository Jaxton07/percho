/**
 * 左侧栏宽度契约（单一事实源）：main 的 `ui-state.ts` 归一化与 renderer 的拖拽/渲染共用同一组上下界。
 * 纯常量 + 纯函数（不 import electron / React），所以 main 与 renderer 都能直接拿。
 */

/** 侧栏默认宽度（没拖过的用户看到的宽度；也是脏值回落的兜底值） */
export const SIDEBAR_DEFAULT_WIDTH = 240;

/** 用户可拖范围（`UiState.sidebarWidth` 落盘前按此夹紧，renderer 的拖拽也在这一步夹住） */
export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 480;

/**
 * 聊天列最小宽：侧栏的**渲染宽**还要被 `(容器宽 - 该值)` 二次夹紧（见 renderer `lib/sidebar-width.ts`），
 * 保证窗口缩小时聊天区不被挤没。
 */
export const CHAT_MIN_WIDTH = 320;

/**
 * 把「用户意图宽度」夹进 `[SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH]` 并取整。
 * 非有限数（脏文件里的字符串/null/数组、未来改上下界后的越界值）一律回落默认宽度。
 */
export function clampSidebarWidth(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return SIDEBAR_DEFAULT_WIDTH;
	return Math.round(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, value)));
}
