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

/* ==========================================================================
 * monaco 代码块的字体度量（spec D4.4）
 * ========================================================================== */

/**
 * monaco 编辑器自己的默认度量（**不是我们的 token**）：它把字号/行高以 inline style 写在
 * `.view-lines` 上，完全不经过 CSS 变量，所以只能由我们把值算好传进 `monacoOptions`。
 *
 * 来源：`monaco-editor/esm/vs/editor/common/config/editorOptions.js` 的
 * `EDITOR_FONT_DEFAULTS`（darwin 子集 fontFamily/fontSize 12/lineHeight 1.5/...）
 * 与 `fontInfo.js` 的 `GOLDEN_LINE_HEIGHT_RATIO`（darwin 1.5、其他 1.35）、`MINIMUM_LINE_HEIGHT` 8。
 * 阶段 0 探针实测：本机（darwin）`.view-lines` 的 inline style 就是 `12px / 18px`（为避免守护测试把注释当成硬编码字号，这里不写 `font-size:` 字面量）
 * —— 正好是 12 × 1.5，也就是下面这组常量在基准档算出来的值（默认档必须与迁移前逐像素一致）。
 */
const MONACO_BASE_FONT_SIZE_DARWIN = 12;
const MONACO_BASE_FONT_SIZE_OTHER = 14;
const MONACO_GOLDEN_LINE_HEIGHT_RATIO_DARWIN = 1.5;
const MONACO_GOLDEN_LINE_HEIGHT_RATIO_OTHER = 1.35;
const MONACO_MINIMUM_LINE_HEIGHT = 8;

/** monaco 在该平台上的基准字号（乘数 1 时的字号） */
export function monacoBaseFontSize(platform: string): number {
	return platform === "darwin" ? MONACO_BASE_FONT_SIZE_DARWIN : MONACO_BASE_FONT_SIZE_OTHER;
}

/**
 * 把「代码字号档位」换算成要传给 monaco 的 `fontSize`：基准字号 × 乘数后再取整
 * （monaco 的 fontSize 是整数像素，半档也要落在整数上才不会出现半像素行）。
 */
export function monacoFontSizeFor(codeFontSize: number, platform: string): number {
	return Math.round(monacoBaseFontSize(platform) * codeFontScale(codeFontSize));
}

/** 与字号配套的 `lineHeight`：按平台的黄金比算，且不低于 monaco 的下限 */
export function monacoLineHeightFor(fontSize: number, platform: string): number {
	const ratio =
		platform === "darwin" ? MONACO_GOLDEN_LINE_HEIGHT_RATIO_DARWIN : MONACO_GOLDEN_LINE_HEIGHT_RATIO_OTHER;
	return Math.max(MONACO_MINIMUM_LINE_HEIGHT, Math.round(fontSize * ratio));
}
