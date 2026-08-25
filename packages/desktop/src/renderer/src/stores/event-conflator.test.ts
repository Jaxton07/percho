import type { SessionEvent } from "@percho/shared";
import { describe, expect, it } from "vitest";
import { EventConflator } from "./event-conflator";

function textDelta(contentIndex: number, delta: string): SessionEvent {
	return {
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", contentIndex, delta },
	} as unknown as SessionEvent;
}

function toolUpdate(toolCallId: string, partialResult: unknown): SessionEvent {
	return {
		type: "tool_execution_update",
		toolCallId,
		toolName: "bash",
		args: {},
		partialResult,
	} as unknown as SessionEvent;
}

/** 同步调度器：捕获 flush 回调，测试手动触发 */
function syncScheduler() {
	let run: (() => void) | null = null;
	const schedule = (flush: () => void) => {
		run = flush;
		return () => {
			run = null;
		};
	};
	return {
		schedule,
		flush: () => {
			if (!run) throw new Error("no flush scheduled");
			run();
		},
		hasScheduled: () => run !== null,
	};
}

function setup() {
	const applied: Array<{ sessionId: string; event: SessionEvent }> = [];
	const sched = syncScheduler();
	const conflator = new EventConflator({
		apply: (sessionId, event) => applied.push({ sessionId, event }),
		schedule: sched.schedule,
	});
	return { conflator, applied, sched };
}

/** noUncheckedIndexedAccess 下取元素：缺失即测试失败（比 ! 断言更早暴露） */
function at<T>(arr: T[], i: number): T {
	const v = arr[i];
	if (v === undefined) throw new Error(`applied[${i}] missing`);
	return v;
}

describe("EventConflator", () => {
	it("同 (会话, 类型, contentIndex) 的连续 text_delta 合并为一条，flush 前不应用", () => {
		const { conflator, applied, sched } = setup();
		conflator.push("s1", textDelta(0, "hello"));
		conflator.push("s1", textDelta(0, " "));
		conflator.push("s1", textDelta(0, "world"));
		expect(applied).toEqual([]);
		expect(sched.hasScheduled()).toBe(true);
		sched.flush();
		expect(applied.length).toBe(1);
		expect(applied[0]).toEqual({
			sessionId: "s1",
			event: textDelta(0, "hello world"),
		});
	});

	it("不同 contentIndex / 不同事件类型互不合并，按首达顺序输出", () => {
		const { conflator, applied, sched } = setup();
		conflator.push("s1", textDelta(0, "a"));
		conflator.push("s1", textDelta(1, "x"));
		conflator.push("s1", textDelta(0, "b"));
		conflator.push("s1", {
			type: "message_update",
			assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "t1" },
		} as unknown as SessionEvent);
		sched.flush();
		expect(
			applied.map((a) => (a.event as { assistantMessageEvent: { type: string } }).assistantMessageEvent.type),
		).toEqual(["text_delta", "text_delta", "thinking_delta"]);
		const deltas = applied.map(
			(a) => (a.event as { assistantMessageEvent: { delta: string } }).assistantMessageEvent.delta,
		);
		expect(deltas[0]).toBe("ab");
		expect(deltas[1]).toBe("x");
		expect(deltas[2]).toBe("t1");
	});

	it("边界事件先冲刷挂起增量再立即应用（顺序保持）", () => {
		const { conflator, applied } = setup();
		conflator.push("s1", textDelta(0, "part1"));
		conflator.push("s1", textDelta(0, "part2"));
		const boundary = { type: "turn_end" } as unknown as SessionEvent;
		conflator.push("s1", boundary);
		// 边界事件同步应用：无需手动 flush
		expect(applied.length).toBe(2);
		expect(at(applied, 0).event).toEqual(textDelta(0, "part1part2"));
		expect(at(applied, 1).event).toBe(boundary);
	});

	it("string 形 tool_execution_update 按 toolCallId 合并；对象形（子代理 details）不合并", () => {
		const { conflator, applied, sched } = setup();
		conflator.push("s1", toolUpdate("t1", "out1"));
		conflator.push("s1", toolUpdate("t1", "out2"));
		conflator.push("s1", toolUpdate("t2", "other"));
		// 对象形 partialResult → 边界事件：立即冲刷 + 应用
		const detailEvent = toolUpdate("t1", { details: { progress: [] } });
		conflator.push("s1", detailEvent);
		expect(applied.length).toBe(3);
		expect((at(applied, 0).event as { partialResult: unknown }).partialResult).toBe("out1out2");
		expect((at(applied, 1).event as { partialResult: unknown }).partialResult).toBe("other");
		expect(at(applied, 2).event).toBe(detailEvent);
		// 边界事件已消费调度：再 flush 无事可做（同步调度器报无调度即证明无残留）
		expect(() => sched.flush()).toThrow();
		expect(applied.length).toBe(3);
	});

	it("多会话独立合流；跨会话边界冲刷不影响正确性", () => {
		const { conflator, applied } = setup();
		conflator.push("s1", textDelta(0, "a"));
		conflator.push("s2", textDelta(0, "x"));
		conflator.push("s2", textDelta(0, "y"));
		conflator.push("s1", textDelta(0, "b"));
		conflator.push("s2", { type: "message_end", message: {} } as unknown as SessionEvent);
		expect(applied.map((a) => a.sessionId)).toEqual(["s1", "s2", "s2"]);
		expect(
			(at(applied, 0).event as { assistantMessageEvent: { delta: string } }).assistantMessageEvent.delta,
		).toBe("ab");
		expect(
			(at(applied, 1).event as { assistantMessageEvent: { delta: string } }).assistantMessageEvent.delta,
		).toBe("xy");
	});

	it("dispose 冲刷挂起增量（卸载时不丢尾帧）", () => {
		const { conflator, applied, sched } = setup();
		conflator.push("s1", textDelta(0, "tail"));
		expect(sched.hasScheduled()).toBe(true);
		conflator.dispose();
		expect(applied.length).toBe(1);
		expect(
			(at(applied, 0).event as { assistantMessageEvent: { delta: string } }).assistantMessageEvent.delta,
		).toBe("tail");
		// dispose 后调度已取消：再次 flush 无效果也无异常
		expect(() => sched.flush()).toThrow();
	});

	it("非 delta 的 message_update（text_start 等）按边界处理", () => {
		const { conflator, applied } = setup();
		conflator.push("s1", textDelta(0, "a"));
		conflator.push("s1", {
			type: "message_update",
			assistantMessageEvent: { type: "text_start", contentIndex: 0 },
		} as unknown as SessionEvent);
		expect(applied.length).toBe(2);
	});

	it("缺 contentIndex 的 delta 不合并（undefined 与 0 语义不同，直接透传）", () => {
		const { conflator, applied } = setup();
		conflator.push("s1", {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "x" },
		} as unknown as SessionEvent);
		// 无调度即无合流：事件已按边界立即应用
		expect(applied.length).toBe(1);
		expect(
			(at(applied, 0).event as { assistantMessageEvent: { delta: string } }).assistantMessageEvent.delta,
		).toBe("x");
	});
});
