/**
 * 字号档位（界面 / 代码）的取值与换算 —— **唯一事实源**（spec D2/D3/D10）。
 *
 * 四层各只干一件事：
 * 1. 本文件（shared）：档位取值、上下界、乘数换算 —— 纯数据 + 纯函数，不碰 DOM、不碰 React；
 * 2. `renderer/src/styles/typography.css`：px 取值 → token 类（`text-ui-13` = `calc(13px * var(--fs-ui-scale, 1))`）；
 * 3. `renderer/src/lib/typography.ts`：把档位写成 CSS 变量（唯一的 DOM 接线点）；
 * 4. `renderer/src/stores/ui-preferences.ts`：持久化（ui-state.json）+ 调 3。
 *
 * 设计要点：
 * - **基准档 = 迁移前的现状**（界面 13px / 代码 12.5px），乘数 1 → 默认档渲染结果必须与改动前逐像素一致（spec D8）；
 *   其它档位只是把乘数改成 `档位值 / 基准值`，token 的 px 值一个字都不用动。
 * - 取值是「连续值链路 + 离散档位收口」：乘数、clamp 都按实数写，将来想放开成滑块只改上下界与 UI。
 * - 脏值（非有限数、越界、缺字段）一律回落基准值 —— 手改 ui-state.json 也不会把界面搞坏。
 */

/** 界面字号：基准 = 迁移前现状 13px（乘数 1）；四档 小 / 默认 / 大 / 更大 */
export const UI_FONT_SIZE_BASE = 13;
export const UI_FONT_SIZE_PRESETS = [12, 13, 15, 17] as const;
export const UI_FONT_SIZE_MIN = 11;
export const UI_FONT_SIZE_MAX = 19;

/** 代码字号：基准 = 迁移前现状 12.5px（乘数 1）；四档 小 / 默认 / 大 / 更大 */
export const CODE_FONT_SIZE_BASE = 12.5;
export const CODE_FONT_SIZE_PRESETS = [11, 12.5, 14, 16] as const;
export const CODE_FONT_SIZE_MIN = 9;
export const CODE_FONT_SIZE_MAX = 20;

/**
 * token 表里允许出现的 px 取值（= `styles/typography.css` 里的全部 `.text-ui-*`，13 个）。
 * 守护测试 `styles/typography.test.ts` 拿它和 CSS 里实际定义的 token 逐一对照
 * —— 防「新增了字号却忘了加 token」这类退化（spec D9.3）。
 */
export const FONT_SIZE_TOKENS = [10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5, 14, 15, 16, 18, 19] as const;

const isFiniteNumber = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value);

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** 界面字号：脏值（非有限数 / 缺字段）回落基准，越界夹到 [MIN, MAX] */
export function clampUiFontSize(value: unknown): number {
	if (!isFiniteNumber(value)) return UI_FONT_SIZE_BASE;
	return clamp(value, UI_FONT_SIZE_MIN, UI_FONT_SIZE_MAX);
}

/** 代码字号：同上 */
export function clampCodeFontSize(value: unknown): number {
	if (!isFiniteNumber(value)) return CODE_FONT_SIZE_BASE;
	return clamp(value, CODE_FONT_SIZE_MIN, CODE_FONT_SIZE_MAX);
}

/** 界面字号乘数（写进 CSS 变量 `--fs-ui-scale`）；基准档恰好是 1 */
export function uiFontScale(uiFontSize: number): number {
	return clampUiFontSize(uiFontSize) / UI_FONT_SIZE_BASE;
}

/** 代码字号乘数（写进 CSS 变量 `--fs-code-scale`）；基准档恰好是 1 */
export function codeFontScale(codeFontSize: number): number {
	return clampCodeFontSize(codeFontSize) / CODE_FONT_SIZE_BASE;
}

/** 显示用文本：整数不带小数点（13px），半档保留一位（12.5px） */
export function formatFontSize(px: number): string {
	return Number.isInteger(px) ? `${px}px` : `${px.toFixed(1)}px`;
}
