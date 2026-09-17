import { describe, expect, it } from "vitest";
import { type MenuAnchor, placeMenu } from "./place-menu";

const viewport = { width: 1200, height: 800 };

function anchor(partial: Partial<MenuAnchor>): MenuAnchor {
	return { left: 100, top: 100, width: 160, height: 28, ...partial };
}

const menu = { width: 176, height: 64 };

describe("placeMenu", () => {
	it("常规：锚在触发元素下沿左对齐（含 4px 间距）", () => {
		expect(placeMenu(anchor({}), menu, viewport)).toEqual({ x: 100, y: 132 });
	});

	it("超视口右缘 → 左翻（右缘对齐后仍超宽时夹进视口）", () => {
		const near = anchor({ left: 1100, width: 160 });
		// 左翻得 1100 + 160 - 176 = 1084，右缘 1260 仍越界 → 夹到 1200 - 176 - 6
		expect(placeMenu(near, menu, viewport)).toEqual({ x: 1018, y: 132 });
	});

	it("下方空间不足且上方够 → 上翻（浮层下缘贴触发元素上沿）", () => {
		const low = anchor({ top: 760, height: 28 });
		// 790 + 64 > 794 → 上翻：760 - 4 - 64
		expect(placeMenu(low, menu, viewport)).toEqual({ x: 100, y: 692 });
	});

	it("上下都放不下时留在下方，并被夹进视口内边距", () => {
		const tall = { width: 176, height: 700 };
		// below = 332，above = -404（负数）→ 留下方；下方也超视口 → 夹到 800 - 700 - 6
		expect(placeMenu(anchor({ top: 300, height: 28 }), tall, viewport)).toEqual({ x: 100, y: 94 });
	});

	it("触发元素贴左/上缘时不会溢出视口", () => {
		expect(placeMenu(anchor({ left: -50, top: -50, height: 28 }), menu, viewport)).toEqual({ x: 6, y: 6 });
	});

	it("右缘左翻后再夹紧：窗口很窄时也不会溢出右缘", () => {
		const tiny = { width: 400, height: 300 };
		const size = { width: 264, height: 90 };
		const { x } = placeMenu(anchor({ left: 320, width: 160 }), size, tiny);
		expect(x).toBe(400 - 264 - 6);
	});

	it("gap 可定制（重命名浮层 8px）", () => {
		expect(placeMenu(anchor({}), menu, viewport, { gap: 8 }).y).toBe(136);
	});
});
