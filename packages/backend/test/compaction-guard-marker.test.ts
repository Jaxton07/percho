import { describe, expect, it } from "vitest";
import { GuardTriggerMarkers } from "../src/tools/compaction-guard/trigger-marker";

/**
 * D8：自研触发的一次性标记（把 UI 上的「手动」改写成「自动（上下文阈值）」）。
 * 关注点：只改副本、one-shot、TTL 作废、真实手动压缩不受影响、多会话不串味。
 */

const START = { type: "compaction_start", reason: "manual" };
const END = { type: "compaction_end", reason: "manual" };

describe("GuardTriggerMarkers", () => {
	it("置标记后：start 与紧跟的 end 都被改写成 threshold（副本，原事件不动）", () => {
		const markers = new GuardTriggerMarkers();
		markers.mark("s1");
		const start = markers.rewrite("s1", START);
		expect(start).toEqual({ type: "compaction_start", reason: "threshold" });
		expect(start).not.toBe(START);
		expect(START.reason).toBe("manual"); // 原事件对象零改动
		const end = markers.rewrite("s1", END);
		expect(end).toEqual({ type: "compaction_end", reason: "threshold" });
		expect(END.reason).toBe("manual");
		expect(markers.has("s1")).toBe(false); // one-shot 在 end 处消费完
	});

	it("没有标记 ⇒ 真实 /compact 原样放行（仍显示手动）", () => {
		const markers = new GuardTriggerMarkers();
		expect(markers.rewrite("s1", START)).toBe(START);
		expect(markers.rewrite("s1", END)).toBe(END);
	});

	it("没等到 start 就过期 ⇒ 作废（不会误改后来的真实手动压缩）", () => {
		let now = 1_000;
		const markers = new GuardTriggerMarkers({ ttlMs: 5_000, now: () => now });
		markers.mark("s1");
		now += 5_001;
		expect(markers.rewrite("s1", START)).toBe(START);
		expect(markers.has("s1")).toBe(false);
	});

	it("压缩耗时长（end 比 start 晚很多）时 end 照样被改写，之后标记才消费掉", () => {
		let now = 1_000;
		const markers = new GuardTriggerMarkers({ ttlMs: 5_000, now: () => now });
		markers.mark("s1");
		expect(markers.rewrite("s1", START)).toEqual({ type: "compaction_start", reason: "threshold" });
		now += 15_000; // 实测事故/冒烟里压缩要十几秒
		expect(markers.rewrite("s1", END)).toEqual({ type: "compaction_end", reason: "threshold" });
		expect(markers.has("s1")).toBe(false);
	});

	it("start 已改写但 end 一直不来（悬挂）⇒ 超 startedTtlMs 后作废，不误改后来的 end", () => {
		let now = 1_000;
		const markers = new GuardTriggerMarkers({ startedTtlMs: 60_000, now: () => now });
		markers.mark("s1");
		markers.rewrite("s1", START);
		now += 60_001;
		expect(markers.rewrite("s1", END)).toBe(END);
		expect(markers.has("s1")).toBe(false);
	});

	it("同一触发里重复的 compaction_start 只改第一次（幂等）", () => {
		const markers = new GuardTriggerMarkers();
		markers.mark("s1");
		expect(markers.rewrite("s1", START)).not.toBe(START);
		const second = { type: "compaction_start", reason: "manual" };
		expect(markers.rewrite("s1", second)).toBe(second);
	});

	it("非 manual 的 compaction_start（SDK 阈值/溢出路径）⇒ 标记作废且不改写", () => {
		const markers = new GuardTriggerMarkers();
		markers.mark("s1");
		const thresholdStart = { type: "compaction_start", reason: "threshold" };
		expect(markers.rewrite("s1", thresholdStart)).toBe(thresholdStart);
		expect(markers.has("s1")).toBe(false);
		expect(markers.rewrite("s1", END)).toBe(END); // 后续真实手动压缩不再被改
	});

	it("两次触发连续：第一次的 end 不吞掉第二次的标记（不串味）", () => {
		const markers = new GuardTriggerMarkers();
		markers.mark("s1");
		markers.rewrite("s1", START);
		// 第一次的 end 到达前，护栏又触发了一次（极端但可能）：重新置标记
		markers.mark("s1");
		expect(markers.rewrite("s1", START)).toEqual({ type: "compaction_start", reason: "threshold" });
		expect(markers.rewrite("s1", END)).toEqual({ type: "compaction_end", reason: "threshold" });
	});

	it("多会话隔离：只有被标记的那个会话被改写", () => {
		const markers = new GuardTriggerMarkers();
		markers.mark("s1");
		expect(markers.rewrite("s2", START)).toBe(START);
		expect(markers.rewrite("s1", START)).not.toBe(START);
	});

	it("不相关事件类型原样返回（引用都不变）", () => {
		const markers = new GuardTriggerMarkers();
		markers.mark("s1");
		const other = { type: "message_start", reason: "manual" };
		expect(markers.rewrite("s1", other)).toBe(other);
	});

	it("clear（收尾/会话关闭）后不再改写", () => {
		const markers = new GuardTriggerMarkers();
		markers.mark("s1");
		markers.clear("s1");
		expect(markers.rewrite("s1", START)).toBe(START);
	});
});
