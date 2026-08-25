import { describe, expect, it } from "vitest";
import {
	contentHash,
	LoopGuard,
	PINGPONG_MAX_WAKES,
	SELF_WRITE_WINDOW_MS,
} from "../src/tools/channel-watch/guard";

function makeGuard(startAt = 1_000_000) {
	let t = startAt;
	const guard = new LoopGuard({ now: () => t });
	return {
		guard,
		advance: (ms: number) => {
			t += ms;
		},
		now: () => t,
	};
}

describe("contentHash", () => {
	it("稳定且区分内容", () => {
		expect(contentHash("abc")).toBe(contentHash("abc"));
		expect(contentHash("abc")).not.toBe(contentHash("abd"));
		expect(contentHash("")).toBe("empty");
	});
});

describe("自写抑制（层 1）", () => {
	it("窗口内命中抑制，窗口过期放行", () => {
		const { guard, advance } = makeGuard();
		guard.markSelfWrite("/repo/a.md");
		expect(guard.isSelfWrite("/repo/a.md")).toBe(true);
		advance(SELF_WRITE_WINDOW_MS - 1);
		expect(guard.isSelfWrite("/repo/a.md")).toBe(true);
		advance(2);
		expect(guard.isSelfWrite("/repo/a.md")).toBe(false);
	});
	it("父目录自写命中子文件事件", () => {
		const { guard } = makeGuard();
		guard.markSelfWrite("/repo/.local/agent-work/channel/t1");
		expect(guard.isSelfWrite("/repo/.local/agent-work/channel/t1/IMPL-NOTES.md")).toBe(true);
		expect(guard.isSelfWrite("/repo/other.md")).toBe(false);
	});
	it("shouldDeliver 集成 self-write 判定", () => {
		const { guard } = makeGuard();
		guard.markSelfWrite("/repo/a.md");
		const d = guard.shouldDeliver("t", "a.md", contentHash("x"), "/repo/a.md");
		expect(d).toMatchObject({ deliver: false, reason: "self-write" });
	});
});

describe("hash 去重（层 2）", () => {
	it("同 hash 不投递，内容变化投递，首次投递", () => {
		const { guard } = makeGuard();
		const h1 = contentHash("v1");
		expect(guard.shouldDeliver("t", "f.md", h1)).toMatchObject({ deliver: true });
		guard.recordDelivered("t", "f.md", h1);
		expect(guard.shouldDeliver("t", "f.md", h1)).toMatchObject({ deliver: false, reason: "hash-unchanged" });
		expect(guard.shouldDeliver("t", "f.md", contentHash("v2"))).toMatchObject({ deliver: true });
	});
	it("同文件不同频道独立判定", () => {
		const { guard } = makeGuard();
		const h = contentHash("x");
		guard.recordDelivered("t1", "f.md", h);
		expect(guard.shouldDeliver("t2", "f.md", h)).toMatchObject({ deliver: true });
	});
});

describe("乒乓上限（层 4）", () => {
	it("窗口内 ≥6 次唤醒暂停，resumeTopic 恢复", () => {
		const { guard, advance } = makeGuard();
		// 5 次不触发
		for (let i = 0; i < PINGPONG_MAX_WAKES - 1; i++) {
			expect(guard.recordWake("t")).toBe(false);
			advance(1000);
		}
		expect(guard.isPaused("t")).toBe(false);
		// 第 6 次触发暂停
		expect(guard.recordWake("t")).toBe(true);
		expect(guard.isPaused("t")).toBe(true);
		expect(guard.shouldDeliver("t", "f.md", contentHash(`n${Date.now()}`))).toMatchObject({
			deliver: false,
			reason: "paused",
		});
		guard.resumeTopic("t");
		expect(guard.isPaused("t")).toBe(false);
	});
	it("10 分钟窗口滑动：老记录滚出不再计数", () => {
		const { guard, advance } = makeGuard();
		for (let i = 0; i < PINGPONG_MAX_WAKES - 1; i++) {
			guard.recordWake("t");
			advance(60_000); // 每分钟一次，5 分钟内 5 次
		}
		advance(6 * 60_000); // 越过 10 分钟窗口
		expect(guard.recordWake("t")).toBe(false); // 历史已滚出
	});
	it("真实用户消息介入清零计数", () => {
		const { guard, advance } = makeGuard();
		for (let i = 0; i < PINGPONG_MAX_WAKES - 1; i++) {
			guard.recordWake("t");
			advance(1000);
		}
		guard.noteUserMessage();
		expect(guard.recordWake("t")).toBe(false);
	});
	it("pausedTopicList 列出暂停频道", () => {
		const { guard } = makeGuard();
		for (let i = 0; i < PINGPONG_MAX_WAKES; i++) guard.recordWake("t1");
		const list = guard.pausedTopicList();
		expect(list).toHaveLength(1);
		expect(list[0]?.topic).toBe("t1");
	});
});

describe("forgetTopic / reset", () => {
	it("forgetTopic 清该频道 hash 与暂停；reset 清全部", () => {
		const { guard } = makeGuard();
		guard.recordDelivered("t1", "f.md", contentHash("x"));
		for (let i = 0; i < PINGPONG_MAX_WAKES; i++) guard.recordWake("t1");
		guard.forgetTopic("t1");
		expect(guard.isPaused("t1")).toBe(false);
		expect(guard.shouldDeliver("t1", "f.md", contentHash("x"))).toMatchObject({ deliver: true });

		guard.recordDelivered("t2", "g.md", contentHash("y"));
		guard.reset();
		expect(guard.shouldDeliver("t2", "g.md", contentHash("y"))).toMatchObject({ deliver: true });
	});
});
