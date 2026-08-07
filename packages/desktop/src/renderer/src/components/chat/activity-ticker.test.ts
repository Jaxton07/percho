import { describe, expect, it } from "vitest";
import { createActivityTicker } from "./activity-ticker";

const MIN = 350;

function ticker() {
	return createActivityTicker({ minDwellMs: MIN });
}

describe("activity ticker", () => {
	it("首条活动立即上屏", () => {
		const t = ticker();
		const snap = t.ingest([{ id: "thinking", kind: "thinking" }], 0);
		expect(snap.currentId).toBe("thinking");
		expect(snap.switchAt).toBeNull();
	});

	it("新活动在最小停留后立即上屏", () => {
		const t = ticker();
		t.ingest([{ id: "thinking", kind: "thinking" }], 0);
		const snap = t.ingest(
			[
				{ id: "thinking", kind: "thinking" },
				{ id: "c0", kind: "tool" },
			],
			MIN + 1,
		);
		expect(snap.currentId).toBe("c0");
		expect(snap.switchAt).toBeNull();
	});

	it("停留期间到达的新活动不立即切换，给出计划切换时间", () => {
		const t = ticker();
		t.ingest([{ id: "c0", kind: "tool" }], 0);
		const snap = t.ingest(
			[
				{ id: "c0", kind: "tool" },
				{ id: "c1", kind: "tool" },
			],
			100,
		);
		expect(snap.currentId).toBe("c0");
		expect(snap.switchAt).toBe(MIN);
	});

	it("爆发合并：停留期间到达多条，到点直接切到最新（跳过中间项）", () => {
		const t = ticker();
		t.ingest([{ id: "c0", kind: "tool" }], 0);
		t.ingest(
			[
				{ id: "c0", kind: "tool" },
				{ id: "c1", kind: "tool" },
			],
			100,
		);
		// c2、c3 在停留期内陆续到达
		const snap = t.ingest(
			[
				{ id: "c0", kind: "tool" },
				{ id: "c1", kind: "tool" },
				{ id: "c2", kind: "tool" },
				{ id: "c3", kind: "tool" },
			],
			200,
		);
		expect(snap.currentId).toBe("c0"); // 仍未切
		expect(snap.switchAt).toBe(MIN);
		// 到点：跳过 c1/c2 直接显示 c3
		const after = t.tick(MIN);
		expect(after.currentId).toBe("c3");
	});

	it("同一活动参数增长（同 id）不触发切换", () => {
		const t = ticker();
		t.ingest([{ id: "c0", kind: "tool" }], 0);
		const snap = t.ingest([{ id: "c0", kind: "tool" }], 5000);
		expect(snap.currentId).toBe("c0");
		expect(snap.switchAt).toBeNull();
	});

	it("活动清空 → 回 fallback（null）", () => {
		const t = ticker();
		t.ingest([{ id: "c0", kind: "tool" }], 0);
		const snap = t.ingest([], 100);
		expect(snap.currentId).toBeNull();
		expect(snap.switchAt).toBeNull();
	});

	it("清空后新活动立即上屏（无历史停留约束）", () => {
		const t = ticker();
		t.ingest([{ id: "c0", kind: "tool" }], 0);
		t.ingest([], 50);
		const snap = t.ingest([{ id: "thinking", kind: "thinking" }], 60);
		expect(snap.currentId).toBe("thinking");
	});

	it("tick 时最新活动已在屏 → 不变", () => {
		const t = ticker();
		t.ingest([{ id: "c0", kind: "tool" }], 0);
		const snap = t.tick(MIN + 1);
		expect(snap.currentId).toBe("c0");
	});

	it("连续切换节奏：每条约停留 minDwell", () => {
		const t = ticker();
		t.ingest([{ id: "c0", kind: "tool" }], 0);
		// c1 在 100 到达，350 切换；c2 在 400 到达（距 350 仅 50ms），700 切换
		t.ingest(
			[
				{ id: "c0", kind: "tool" },
				{ id: "c1", kind: "tool" },
			],
			100,
		);
		const s1 = t.tick(MIN);
		expect(s1.currentId).toBe("c1");
		const s2 = t.ingest(
			[
				{ id: "c0", kind: "tool" },
				{ id: "c1", kind: "tool" },
				{ id: "c2", kind: "tool" },
			],
			400,
		);
		expect(s2.currentId).toBe("c1");
		expect(s2.switchAt).toBe(2 * MIN);
		const s3 = t.tick(2 * MIN);
		expect(s3.currentId).toBe("c2");
	});
});
