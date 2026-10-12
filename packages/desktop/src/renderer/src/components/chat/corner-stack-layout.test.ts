import { describe, expect, it } from "vitest";
import {
	CORNER_STACK_BASE_TOP,
	CORNER_STACK_GAP,
	CORNER_STACK_LEGACY_LEAD,
	cornerStackLead,
	cornerStackTop,
} from "./corner-stack-layout";

/**
 * 右上堆叠的布局算式（spec D2 / 阶段 0 实测口径）。这里是阶段 0 探针断言过的三条规则：
 * 有 Todo ⇒ 底边 +8；无 Todo ⇒ 回到 top-2；无 Todo 且无胶囊 ⇒ 贡献保留现状 56px 基线。
 */
describe("cornerStackTop", () => {
	it("有 Todo：锚点底边 + 8px（相对 main 顶边）", () => {
		expect(cornerStackTop(48, 40)).toBe(16);
		expect(cornerStackTop(323.5, 40)).toBe(291.5); // 长列表触顶后的底边照样跟
	});

	it("没有 Todo：回到 top-2 = 8px（与默认 TodoPanel 原右上角一致）", () => {
		expect(cornerStackTop(null, 0)).toBe(CORNER_STACK_BASE_TOP);
		expect(cornerStackTop(null, 137)).toBe(CORNER_STACK_BASE_TOP);
	});

	it("间距常量是 8px（设计基准）", () => {
		expect(CORNER_STACK_GAP).toBe(8);
	});
});

describe("cornerStackLead（右上贡献的前置间距）", () => {
	it("有 Todo：0（贡献紧跟胶囊/锚点）", () => {
		expect(cornerStackLead(true, false)).toBe(0);
		expect(cornerStackLead(true, true)).toBe(0);
	});

	it("无 Todo 但有胶囊：0（胶囊占 Todo 原位置，贡献排在它下面）", () => {
		expect(cornerStackLead(false, true)).toBe(0);
	});

	it("既无 Todo 也无胶囊：48px（合计 56px = 现状 pt-12 基线，第三方贡献观感不变）", () => {
		expect(cornerStackLead(false, false)).toBe(CORNER_STACK_LEGACY_LEAD);
		expect(CORNER_STACK_BASE_TOP + CORNER_STACK_LEGACY_LEAD).toBe(56);
	});

	it("退场中的胶囊仍算「有胶囊」（按实际占位，收起结束才切基线）", () => {
		// mounted（离场中）= 占位仍在 ⇒ 传 true
		expect(cornerStackLead(false, true)).toBe(0);
	});
});
