/**
 * 右上堆叠（CornerStack）的布局算式（pure，spec D2 / 阶段 0 实测口径）。
 *
 * | 场景 | stack.top | 右上贡献的前置间距 |
 * | 有 Todo | anchor.bottom − main.top + 8 | 0（排在胶囊下方 8px） |
 * | 无 Todo + 有胶囊 | 8（= Todo 原右上角位置） | 0（排在胶囊下方 8px） |
 * | 无 Todo + 无胶囊 | 8 | 48px（合计 56px = 现状 `pt-12` 基线，第三方贡献观感不变） |
 */
export const CORNER_STACK_BASE_TOP = 8;
export const CORNER_STACK_GAP = 8;
export const CORNER_STACK_LEGACY_LEAD = 48;

/** 堆叠容器相对 main 顶边的 top（没有 anchor 时回到基准位） */
export function cornerStackTop(anchorBottom: number | null, containerTop: number): number {
	if (anchorBottom === null) return CORNER_STACK_BASE_TOP;
	return anchorBottom - containerTop + CORNER_STACK_GAP;
}

/** 右上贡献的前置间距：只有「既没有 Todo 也没有胶囊」时才保留现状的 56px 基线 */
export function cornerStackLead(hasAnchor: boolean, hasPill: boolean): number {
	return !hasAnchor && !hasPill ? CORNER_STACK_LEGACY_LEAD : 0;
}
