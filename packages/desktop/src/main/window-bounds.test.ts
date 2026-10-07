import { describe, expect, it } from "vitest";
import {
	BOUNDS_MIN_VISIBLE_H,
	BOUNDS_MIN_VISIBLE_W,
	sanitizeWindowBounds,
	WINDOW_DEFAULT_HEIGHT,
	WINDOW_DEFAULT_WIDTH,
	WINDOW_MIN_HEIGHT,
	WINDOW_MIN_WIDTH,
} from "./window-bounds";

/** 主屏（含菜单栏的可见区）与左侧副屏 —— 副屏 x 为负是合法场景 */
const MAIN = { x: 0, y: 25, width: 1440, height: 875 };
const LEFT = { x: -1280, y: 0, width: 1280, height: 800 };
const TINY = { x: 0, y: 0, width: 800, height: 600 };

describe("sanitizeWindowBounds", () => {
	it("缺省（null）→ null（调用方走默认尺寸与系统摆放）", () => {
		expect(sanitizeWindowBounds(null, [MAIN])).toBeNull();
	});

	it("没有任何屏幕（拔掉所有外接屏 + 主屏数据拿不到）→ null", () => {
		expect(sanitizeWindowBounds({ x: 100, y: 100, width: 1000, height: 700 }, [])).toBeNull();
	});

	it("完全落在屏幕内 → 原样保留", () => {
		const bounds = { x: 120, y: 60, width: 1000, height: 700 };
		expect(sanitizeWindowBounds(bounds, [MAIN])).toEqual(bounds);
	});

	it("拔屏场景：那块屏没了（交集不足最小可视尺寸）→ null", () => {
		// 窗口整体在右侧那块副屏上，副屏拔了只剩主屏 → 交集为 0
		expect(sanitizeWindowBounds({ x: 1500, y: 100, width: 900, height: 600 }, [MAIN])).toBeNull();
		// 只露出几十像素（宽度够但高度不够 / 高度够但宽度不够）同样算「看不见」
		expect(
			sanitizeWindowBounds(
				{ x: MAIN.x + MAIN.width - (BOUNDS_MIN_VISIBLE_W - 1), y: 100, width: 900, height: 600 },
				[MAIN],
			),
		).toBeNull();
		expect(
			sanitizeWindowBounds(
				{ x: 100, y: MAIN.y + MAIN.height - (BOUNDS_MIN_VISIBLE_H - 1), width: 900, height: 600 },
				[MAIN],
			),
		).toBeNull();
	});

	it("刚好够最小可视尺寸 → 平移回屏内（不判空）", () => {
		const bounds = {
			x: MAIN.x + MAIN.width - BOUNDS_MIN_VISIBLE_W,
			y: MAIN.y + MAIN.height - BOUNDS_MIN_VISIBLE_H,
			width: 900,
			height: 600,
		};
		expect(sanitizeWindowBounds(bounds, [MAIN])).toEqual({
			x: MAIN.x + MAIN.width - 900,
			y: MAIN.y + MAIN.height - 600,
			width: 900,
			height: 600,
		});
	});

	it("换小屏：宽高夹到 workArea 尺寸，再平移进屏", () => {
		const bounds = { x: 100, y: 100, width: 1920, height: 1080 };
		expect(sanitizeWindowBounds(bounds, [TINY])).toEqual({
			x: 0,
			y: 0,
			width: 800,
			height: 600,
		});
	});

	it("平移：窗口大部分在屏外时被拉回屏内", () => {
		const bounds = { x: MAIN.x + MAIN.width - 200, y: MAIN.y - 40, width: 1000, height: 700 };
		expect(sanitizeWindowBounds(bounds, [MAIN])).toEqual({
			x: MAIN.x + MAIN.width - 1000,
			y: MAIN.y,
			width: 1000,
			height: 700,
		});
	});

	it("多屏：取交集面积最大的那块（等价 getDisplayMatching）", () => {
		// 主体在主屏、只压到副屏一点 → 按主屏夹
		const mostlyMain = { x: -100, y: 100, width: 900, height: 600 };
		expect(sanitizeWindowBounds(mostlyMain, [MAIN, LEFT])).toEqual({
			x: 0,
			y: 100,
			width: 900,
			height: 600,
		});
		// 主体在副屏 → 按副屏夹，x 保持负值
		const mostlyLeft = { x: -1200, y: 60, width: 900, height: 600 };
		expect(sanitizeWindowBounds(mostlyLeft, [MAIN, LEFT])).toEqual({
			x: -1200,
			y: 60,
			width: 900,
			height: 600,
		});
	});

	it("左侧副屏：x 为负是合法值，不会被夹成 0", () => {
		const bounds = { x: -1000, y: 100, width: 900, height: 600 };
		expect(sanitizeWindowBounds(bounds, [LEFT])).toEqual(bounds);
	});

	it("非有限数（手改文件 / NaN）→ null", () => {
		for (const raw of [
			{ x: Number.NaN, y: 0, width: 900, height: 600 },
			{ x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 600 },
			{ x: 0, y: 0, width: 900, height: Number.NEGATIVE_INFINITY },
		]) {
			expect(sanitizeWindowBounds(raw, [MAIN]), JSON.stringify(raw)).toBeNull();
		}
	});

	it("常量契约：默认尺寸 ≥ 最小尺寸（否则默认窗会构造失败）", () => {
		expect(WINDOW_DEFAULT_WIDTH).toBeGreaterThanOrEqual(WINDOW_MIN_WIDTH);
		expect(WINDOW_DEFAULT_HEIGHT).toBeGreaterThanOrEqual(WINDOW_MIN_HEIGHT);
	});
});
