import { describe, expect, it } from "vitest";
import { sidebarRenderWidth } from "./sidebar-width";

describe("sidebarRenderWidth（渲染宽 = 用户意图值再被容器宽夹紧）", () => {
	it("容器够宽时就是用户值", () => {
		expect(sidebarRenderWidth(480, 1100)).toBe(480);
		expect(sidebarRenderWidth(240, 1100)).toBe(240);
	});

	it("容器不够宽时夹到「容器宽 - 聊天列最小宽」", () => {
		// 侧栏 480 + 窗口 640 → 聊天列只能拿 320，侧栏被夹到 320（REVIEW R1 的触发区间）
		expect(sidebarRenderWidth(480, 640)).toBe(320);
		expect(sidebarRenderWidth(480, 800)).toBe(480);
		expect(sidebarRenderWidth(480, 799)).toBe(479);
	});

	it("容器宽未知（首帧 ResizeObserver 还没上报）退回用户值，不把侧栏挤成最小宽", () => {
		expect(sidebarRenderWidth(480, 0)).toBe(480);
		expect(sidebarRenderWidth(480, Number.NaN)).toBe(480);
	});

	it("用户值先过 clamp（脏值/越界不影响渲染宽）", () => {
		expect(sidebarRenderWidth(900, 1100)).toBe(480);
		expect(sidebarRenderWidth(100, 1100)).toBe(200);
		expect(sidebarRenderWidth(Number.NaN, 1100)).toBe(240);
	});

	it("容器极窄时不低于侧栏最小宽（窗口 minWidth 640 已从源头挡住这种情形）", () => {
		expect(sidebarRenderWidth(240, 400)).toBe(200);
	});
});
