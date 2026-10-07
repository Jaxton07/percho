import {
	CODE_FONT_SIZE_BASE,
	CODE_FONT_SIZE_MAX,
	CODE_FONT_SIZE_MIN,
	CODE_FONT_SIZE_PRESETS,
	codeFontScale,
	FONT_SIZE_TOKENS,
	formatFontSize,
	UI_FONT_SIZE_BASE,
	UI_FONT_SIZE_MAX,
	UI_FONT_SIZE_MIN,
	UI_FONT_SIZE_PRESETS,
	uiFontScale,
} from "@percho/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	applyFontScales,
	CODE_FONT_SCALE_VAR,
	monacoBaseFontSize,
	monacoFontSizeFor,
	monacoLineHeightFor,
	UI_FONT_SCALE_VAR,
} from "./typography";

/**
 * vitest 跑在 node 环境（本仓库没装 jsdom），所以这里自己 stub 一个最小 `document`：
 * 只断言「我们确实往 documentElement 的 inline style 上写了这两个变量」，浏览器行为交给
 * `scripts/check-font-size.mjs` 的截图比对去证。
 */
const written = new Map<string, string>();
beforeEach(() => {
	written.clear();
	vi.stubGlobal("document", {
		documentElement: { style: { setProperty: (key: string, value: string) => written.set(key, value) } },
	});
});

/**
 * 字号档位 → CSS 变量的接线测试（spec D2/D3/D10）。
 *
 * 这一层是「设置项真的会改界面」的最后一米：档位 → 乘数 → `--fs-ui-scale` / `--fs-code-scale`；
 * token 那侧（`calc(px * var(...))`）由 `styles/typography.test.ts` 守着。
 */
describe("档位定义", () => {
	it("两行档位各自 4 档，且都在 clamp 上下界内（面板上每档都可选，不会被夹）", () => {
		expect(UI_FONT_SIZE_PRESETS).toHaveLength(4);
		expect(CODE_FONT_SIZE_PRESETS).toHaveLength(4);
		for (const px of UI_FONT_SIZE_PRESETS) {
			expect(px).toBeGreaterThanOrEqual(UI_FONT_SIZE_MIN);
			expect(px).toBeLessThanOrEqual(UI_FONT_SIZE_MAX);
		}
		for (const px of CODE_FONT_SIZE_PRESETS) {
			expect(px).toBeGreaterThanOrEqual(CODE_FONT_SIZE_MIN);
			expect(px).toBeLessThanOrEqual(CODE_FONT_SIZE_MAX);
		}
	});

	it("基准档就是迁移前的现状（13 / 12.5），且一定在档位表里", () => {
		expect(UI_FONT_SIZE_BASE).toBe(13);
		expect(CODE_FONT_SIZE_BASE).toBe(12.5);
		expect(UI_FONT_SIZE_PRESETS).toContain(UI_FONT_SIZE_BASE);
		expect(CODE_FONT_SIZE_PRESETS).toContain(CODE_FONT_SIZE_BASE);
	});

	it("token 取值集合覆盖所有档位可能用到的字号（新增档位必须同时加 token）", () => {
		// 档位是乘数，不直接对应 token 值；这里只保证 token 表非空且是递增去重的
		expect(FONT_SIZE_TOKENS.length).toBeGreaterThanOrEqual(10);
		expect([...FONT_SIZE_TOKENS].sort((a, b) => a - b)).toEqual([...FONT_SIZE_TOKENS]);
		expect(new Set(FONT_SIZE_TOKENS).size).toBe(FONT_SIZE_TOKENS.length);
	});
});

describe("乘数换算", () => {
	it("基准档恰好是 1（默认档渲染 == 迁移前现状，spec D8 的安全网）", () => {
		expect(uiFontScale(UI_FONT_SIZE_BASE)).toBe(1);
		expect(codeFontScale(CODE_FONT_SIZE_BASE)).toBe(1);
	});

	it("其它档位 = 档位值 / 基准值", () => {
		expect(uiFontScale(12)).toBe(12 / 13);
		expect(uiFontScale(17)).toBe(17 / 13);
		expect(codeFontScale(11)).toBe(11 / 12.5);
		expect(codeFontScale(16)).toBe(16 / 12.5);
	});

	it("脏值/越界一律收口（设置项与手改 json 共用这条防线）", () => {
		expect(uiFontScale(Number.NaN)).toBe(1);
		expect(uiFontScale(Number.POSITIVE_INFINITY)).toBe(1);
		expect(uiFontScale(99)).toBe(UI_FONT_SIZE_MAX / UI_FONT_SIZE_BASE);
		expect(uiFontScale(1)).toBe(UI_FONT_SIZE_MIN / UI_FONT_SIZE_BASE);
		expect(codeFontScale(0)).toBe(CODE_FONT_SIZE_MIN / CODE_FONT_SIZE_BASE);
	});
});

describe("写 CSS 变量（唯一的 DOM 接线点）", () => {
	it("两个变量都写到 documentElement 的 inline style 上", () => {
		applyFontScales(15, 14);
		expect(written.get(UI_FONT_SCALE_VAR)).toBe(String(15 / 13));
		expect(written.get(CODE_FONT_SCALE_VAR)).toBe(String(14 / 12.5));
	});

	it("切回基准档 → 变量值为 1（= typography.css 的兜底值，渲染回到基线）", () => {
		applyFontScales(15, 14);
		applyFontScales(UI_FONT_SIZE_BASE, CODE_FONT_SIZE_BASE);
		expect(written.get(UI_FONT_SCALE_VAR)).toBe("1");
		expect(written.get(CODE_FONT_SCALE_VAR)).toBe("1");
	});
});

describe("显示文本", () => {
	it("整数不带小数点，半档保留一位", () => {
		expect(formatFontSize(13)).toBe("13px");
		expect(formatFontSize(12.5)).toBe("12.5px");
		expect(formatFontSize(10.5)).toBe("10.5px");
	});
});

describe("monaco 代码块度量（spec D4.4）", () => {
	it("基准字号照 monaco 的平台默认：darwin 12 / 其他 14", () => {
		expect(monacoBaseFontSize("darwin")).toBe(12);
		expect(monacoBaseFontSize("win32")).toBe(14);
		expect(monacoBaseFontSize("linux")).toBe(14);
	});

	it("基准档恰好是 monaco 自己的默认值（12 / 18 = 迁移前 .view-lines 上的 inline style）", () => {
		expect(monacoFontSizeFor(12.5, "darwin")).toBe(12);
		expect(monacoLineHeightFor(12, "darwin")).toBe(18);
	});

	it("四档取整：darwin 11 / 12 / 13 / 15px（11.5→11 走 round）", () => {
		expect(CODE_FONT_SIZE_PRESETS.map((px) => monacoFontSizeFor(px, "darwin"))).toEqual([11, 12, 13, 15]);
	});

	it("行高按平台黄金比：darwin 1.5 / 其他 1.35，且不低于 monaco 的下限 8", () => {
		expect(monacoLineHeightFor(12, "darwin")).toBe(18);
		expect(monacoLineHeightFor(14, "darwin")).toBe(21);
		expect(monacoLineHeightFor(14, "win32")).toBe(19);
		expect(monacoLineHeightFor(1, "darwin")).toBe(8);
	});

	it("非 darwin 档位按 14 基准换算（切换平台不会退回默认字号）", () => {
		expect(CODE_FONT_SIZE_PRESETS.map((px) => monacoFontSizeFor(px, "linux"))).toEqual([12, 14, 16, 18]);
	});

	it("脏档位走同一套 clamp（不会算出离谱字号）", () => {
		expect(monacoFontSizeFor(Number.NaN, "darwin")).toBe(12);
		expect(monacoFontSizeFor(999, "darwin")).toBe(Math.round((12 * 20) / 12.5));
	});
});
