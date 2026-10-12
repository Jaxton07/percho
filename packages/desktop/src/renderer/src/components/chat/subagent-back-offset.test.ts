import { describe, expect, it } from "vitest";
import { backButtonOffset } from "./subagent-back-offset";

/**
 * 「返回父会话」入口的水平偏移（验收后调整）：入口中心落在「聊天区左缘 ↔ 对话区内容左缘」空带正中，
 * 空带不够宽时退回贴左缘的基线位置（0）。
 * 基准数字就是真机 dev 的实际几何（聊天区 1098 / 列盒 760 居中 ⇒ 左缘 169 / 列内边距 24 / 入口 42 / 角容器 left-4 = 16）。
 */
const base = {
	mainLeft: 0,
	naturalLeft: 16, // 角容器 left-4
	columnLeft: 169, // (1098 - 760) / 2
	columnPaddingLeft: 24,
	buttonWidth: 42,
};

/** 入口落位后的中心相对空带中点的偏差（fp 说明：取整会带来 ≤ 0.5px 偏差） */
function centerDeviation(input: Parameters<typeof backButtonOffset>[0]): number {
	const contentLeft = input.columnLeft + input.columnPaddingLeft;
	const bandCenter = input.mainLeft + (contentLeft - input.mainLeft) / 2;
	const actual = input.naturalLeft + backButtonOffset(input) + input.buttonWidth / 2;
	return Math.round((actual - bandCenter) * 10) / 10;
}

describe("backButtonOffset", () => {
	it("宽聊天区：入口中心落在带子正中（偏移 60，中心偏差 0.5px 内）", () => {
		expect(backButtonOffset(base)).toBe(60);
		expect(centerDeviation(base)).toBe(0.5);
	});

	it("聊天区变宽/变窄：偏移随之变化，且中心始终对在带子中点", () => {
		const narrow = backButtonOffset({ ...base, columnLeft: 119 }); // 聊天区 998
		const wide = backButtonOffset({ ...base, columnLeft: 269 }); // 聊天区 1298
		expect([narrow, wide]).toEqual([35, 110]);
		expect(wide).toBeGreaterThan(narrow);
		for (const columnLeft of [119, 169, 269, 419]) {
			expect(Math.abs(centerDeviation({ ...base, columnLeft }))).toBeLessThanOrEqual(0.5);
		}
	});

	it("左栏展开（聊天区整体右移）：同一坐标系里算，偏移只由带子宽度决定", () => {
		// 聊天区左缘 240、858 宽 ⇒ 列盒 289、内容左缘 313、中点 276.5；入口左缘 255.5 < 基线 256 ⇒ 0
		expect(
			backButtonOffset({
				mainLeft: 240,
				naturalLeft: 256,
				columnLeft: 289,
				columnPaddingLeft: 24,
				buttonWidth: 42,
			}),
		).toBe(0);
		// 同一带子（143px）在任意绝对位置上得到同一个偏移
		expect(backButtonOffset({ ...base, columnLeft: 119 })).toBe(
			backButtonOffset({
				mainLeft: 500,
				naturalLeft: 516,
				columnLeft: 619,
				columnPaddingLeft: 24,
				buttonWidth: 42,
			}),
		);
	});

	it("空带不够宽（列已占满聊天区）：归 0 —— 保持贴左缘的基线位置，且不退化成负偏移", () => {
		expect(backButtonOffset({ ...base, columnLeft: 0 })).toBe(0); // 内容左缘 24 ⇒ 中点 12
		expect(backButtonOffset({ ...base, columnLeft: -100 })).toBe(0);
		// 全部退化情形都是正零（不出现 -0，避免 `Object.is` 抖动）
		expect(Object.is(backButtonOffset({ ...base, columnLeft: -100 }), 0)).toBe(true);
	});

	it("阈值附近：中点 - 半宽 - 基线 = 0 时归 0，跨过 0.5px 才挪 1px", () => {
		// 需要偏移 = 0 ⇔ 中点 = 16 + 21 = 37 ⇔ columnLeft = 50
		expect(backButtonOffset({ ...base, columnLeft: 50 })).toBe(0);
		expect(backButtonOffset({ ...base, columnLeft: 50.4 })).toBe(0); // 0.2 → 取整 0
		expect(backButtonOffset({ ...base, columnLeft: 52 })).toBe(1);
	});

	it("入口宽度变化：仍是中心对齐（宽的一半变小/变大）", () => {
		expect(backButtonOffset({ ...base, buttonWidth: 28 })).toBe(67);
		expect(backButtonOffset({ ...base, buttonWidth: 56 })).toBe(53);
		expect(centerDeviation({ ...base, buttonWidth: 56 })).toBe(0.5);
	});

	it("列内边距变化也算进去（可见内容左缘才是视觉上的「对话区」边界）", () => {
		expect(backButtonOffset({ ...base, columnPaddingLeft: 0 })).toBe(48);
		expect(backButtonOffset({ ...base, columnPaddingLeft: 48 })).toBe(72);
	});
});
