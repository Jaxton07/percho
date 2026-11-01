import { describe, expect, it } from "vitest";
import {
	clampWindowStart,
	expandWindowStart,
	INITIAL_MOUNTED_ROWS,
	MOUNT_CHUNK_ROWS,
	prependWindowStart,
	tailWindowStart,
} from "./mount-window";

describe("tailWindowStart", () => {
	it("短会话（≤ 窗口）全部挂载", () => {
		expect(tailWindowStart(0)).toBe(0);
		expect(tailWindowStart(12)).toBe(0);
		expect(tailWindowStart(INITIAL_MOUNTED_ROWS)).toBe(0);
	});

	it("长会话只留尾部窗口", () => {
		expect(tailWindowStart(INITIAL_MOUNTED_ROWS + 1)).toBe(1);
		expect(tailWindowStart(1278)).toBe(1278 - INITIAL_MOUNTED_ROWS);
	});

	it("脏输入不产生负起点", () => {
		expect(tailWindowStart(Number.NaN)).toBe(0);
		expect(tailWindowStart(-5)).toBe(0);
	});
});

describe("expandWindowStart", () => {
	it("每次向上补挂一块", () => {
		expect(expandWindowStart(100, 200)).toBe(100 - MOUNT_CHUNK_ROWS);
	});

	it("补到顶部夹到 0", () => {
		expect(expandWindowStart(MOUNT_CHUNK_ROWS, 200)).toBe(0);
		expect(expandWindowStart(3, 200)).toBe(0);
	});

	it("已在顶部保持 0", () => {
		expect(expandWindowStart(0, 200)).toBe(0);
		expect(expandWindowStart(-1, 200)).toBe(0);
	});
});

describe("prependWindowStart", () => {
	it("前插先平移旧起点，仅新增30行挂载，旧窗口不被吞掉", () => {
		expect(prependWindowStart(0, 100, 120)).toBe(70);
		expect(120 - prependWindowStart(0, 100, 120)).toBe(20 + MOUNT_CHUNK_ROWS);
		expect(prependWindowStart(40, 100, 180)).toBe(110);
	});
	it("短页可全部补挂，继续前插仍可按块展开", () => {
		expect(prependWindowStart(0, 8, 28)).toBe(0);
		expect(expandWindowStart(prependWindowStart(0, 100, 120), 120)).toBe(40);
	});
});

describe("clampWindowStart", () => {
	it("正常起点原样返回", () => {
		expect(clampWindowStart(30, 200)).toBe(30);
	});

	it("行数变少到窗口以下 → 回退为尾部窗口（不出现空列表）", () => {
		expect(clampWindowStart(500, 200)).toBe(tailWindowStart(200));
		// 行数少到不足一个窗口时回退到 0 = 全部挂载
		expect(clampWindowStart(500, 10)).toBe(0);
	});

	it("起点在窗口内但行数刚好等于起点 → 尾部窗口", () => {
		expect(clampWindowStart(200, 200)).toBe(tailWindowStart(200));
	});

	it("脏输入归零", () => {
		expect(clampWindowStart(Number.NaN, 200)).toBe(0);
		expect(clampWindowStart(-3, 200)).toBe(0);
		expect(clampWindowStart(12.7, 200)).toBe(12);
	});
});
