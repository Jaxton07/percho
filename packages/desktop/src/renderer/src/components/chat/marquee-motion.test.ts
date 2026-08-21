import { describe, expect, it } from "vitest";
import { tailOffsetForWidths } from "./marquee-motion";

describe("streaming preview tail-follow motion", () => {
	it("无效尺寸时停在开头", () => {
		expect(tailOffsetForWidths(Number.NaN, 100)).toBe(0);
		expect(tailOffsetForWidths(100, Number.POSITIVE_INFINITY)).toBe(0);
	});

	it("未溢出时停在开头", () => {
		expect(tailOffsetForWidths(80, 100)).toBe(0);
		expect(tailOffsetForWidths(100, 100)).toBe(0);
	});

	it("溢出时右对齐到最新文本", () => {
		expect(tailOffsetForWidths(140, 100)).toBe(40);
	});

	it("文本增长时以增长量同步推进", () => {
		const initial = tailOffsetForWidths(140, 100);
		const afterDelta = tailOffsetForWidths(167, 100);
		expect(afterDelta - initial).toBe(27);
	});

	it("视口增长时回退到仍可见的最近位置", () => {
		expect(tailOffsetForWidths(167, 140)).toBe(27);
	});
});
