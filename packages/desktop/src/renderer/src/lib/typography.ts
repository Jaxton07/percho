import { codeFontScale, uiFontScale } from "@percho/shared";

/**
 * 字号档位 → CSS 变量的**唯一 DOM 接线点**（spec D10 第 3 层）。
 *
 * typography.css 里每个 token 都是 `calc(<px> * var(--fs-ui-scale, 1))`，所以「换档位」就是改这两个变量的值；
 * 走 CSS 变量意味着：改一次变量、整棵子树跟着变，**不需要 React 重渲染**，也不会有逐组件漏改。
 *
 * 基准档的乘数恰好是 1（13/13、12.5/12.5）→ 默认档写出的值与 typography.css 里的兜底值相同，
 * 渲染结果与迁移前逐像素一致（spec D8 的安全网）。
 */
export const UI_FONT_SCALE_VAR = "--fs-ui-scale";
export const CODE_FONT_SCALE_VAR = "--fs-code-scale";

/** 把两个档位写进 `document.documentElement` 的 inline style（inline 比 typography.css 里的 `:root` 兜底优先） */
export function applyFontScales(uiFontSize: number, codeFontSize: number): void {
	const style = document.documentElement.style;
	style.setProperty(UI_FONT_SCALE_VAR, String(uiFontScale(uiFontSize)));
	style.setProperty(CODE_FONT_SCALE_VAR, String(codeFontScale(codeFontSize)));
}
