import { describe, expect, it } from "vitest";
import { EventRateTracker } from "../src/session/rates";

const sec = (s: number): number => s * 1000;

describe("EventRateTracker", () => {
	it("首事件建桶，同秒累加", () => {
		const t = new EventRateTracker();
		t.tick("a", sec(100));
		t.tick("a", sec(100) + 500);
		const snap = t.snapshot().get("a");
		expect(snap?.window60s).toEqual([2]);
		expect(snap?.lastEventAt).toBe(sec(100) + 500);
	});

	it("跨秒补零：每秒一桶，窗口内逐秒计数", () => {
		const t = new EventRateTracker();
		for (let i = 0; i < 3; i++) {
			t.tick("a", sec(100 + i));
			t.tick("a", sec(100 + i) + 10);
		}
		expect(t.snapshot().get("a")?.window60s).toEqual([2, 2, 2]);
	});

	it("闲置超过整个窗口：旧计数整段丢弃（不灌 60 个零）", () => {
		const t = new EventRateTracker();
		t.tick("a", sec(100));
		t.tick("a", sec(100) + 3);
		t.tick("a", sec(161)); // 61s 后
		expect(t.snapshot().get("a")?.window60s).toEqual([1]);
	});

	it("窗口封顶 60 桶，最旧的先滑出", () => {
		const t = new EventRateTracker();
		for (let i = 0; i < 70; i++) t.tick("a", sec(100 + i));
		const window = t.snapshot().get("a")?.window60s;
		expect(window).toHaveLength(60);
		expect(window?.[0]).toBe(1); // 第 100+10 秒的桶（前 10 秒已滑出）
	});

	it("snapshot 返回拷贝，外改不污染内部", () => {
		const t = new EventRateTracker();
		t.tick("a", sec(100));
		const snap = t.snapshot().get("a");
		snap?.window60s.push(999);
		expect(t.snapshot().get("a")?.window60s).toEqual([1]);
	});

	it("delete 清理指定会话；prune 回收非 keep 且闲置超时的条目", () => {
		const t = new EventRateTracker();
		t.tick("live", sec(100));
		t.tick("sub-old", sec(100));
		t.tick("sub-fresh", sec(160));
		t.delete("live");
		t.prune(() => false, sec(161)); // 61s 后：sub-old 闲置 61s 回收，sub-fresh 仅 1s 保留
		const ids = [...t.snapshot().keys()];
		expect(ids).toEqual(["sub-fresh"]);
	});

	it("prune 不动 keep 内的条目（活跃会话即使闲置也保留 lastEventAt）", () => {
		const t = new EventRateTracker();
		t.tick("open-session", sec(100));
		t.prune((id) => id === "open-session", sec(1000));
		expect(t.snapshot().has("open-session")).toBe(true);
	});
});
