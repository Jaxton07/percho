import type { SessionEvent } from "@percho/shared";
import { describe, expect, it } from "vitest";
import { StreamGuard } from "../src/session/stream-guard";

function delta(text: string, type = "thinking_delta"): SessionEvent {
	return {
		type: "message_update",
		assistantMessageEvent: { type, contentIndex: 0, delta: text },
	} as unknown as SessionEvent;
}

function boundary(kind: "message_start" | "message_end"): SessionEvent {
	return { type: kind, message: { role: "assistant", content: [] } } as unknown as SessionEvent;
}

describe("StreamGuard", () => {
	it("正常文本流不触发", () => {
		const guard = new StreamGuard({ wsRunBytes: 100, totalBytes: 1000 });
		for (let i = 0; i < 50; i++) expect(guard.inspect("s", delta(`正常内容${i}，`))).toBe("pass");
	});

	it("连续空白洪流触发 trip_whitespace，随后 suppress", () => {
		const guard = new StreamGuard({ wsRunBytes: 100, totalBytes: 1000 });
		expect(guard.inspect("s", delta("\n    ".repeat(10)))).toBe("pass"); // 50 字节
		expect(guard.inspect("s", delta("有内容"))).toBe("pass"); // wsRun 归零
		expect(guard.inspect("s", delta("\n    ".repeat(20)))).toBe("pass"); // 100 字节（未超）
		expect(guard.inspect("s", delta("\n"))).toBe("trip_whitespace"); // 101 字节
		expect(guard.inspect("s", delta("x"))).toBe("suppress");
		expect(guard.inspect("s", delta("y"))).toBe("suppress");
	});

	it("混合空白+非空白不会误触发（缩进/换行常夹在代码文本里）", () => {
		const guard = new StreamGuard({ wsRunBytes: 64, totalBytes: 1024 * 1024 });
		for (let i = 0; i < 200; i++) {
			expect(guard.inspect("s", delta("def f():\n\t\treturn 1  # 注释\n"))).toBe("pass");
		}
	});

	it("非空白超量触发 trip_oversize", () => {
		const guard = new StreamGuard({ wsRunBytes: 100, totalBytes: 200 });
		expect(guard.inspect("s", delta("a".repeat(150)))).toBe("pass");
		expect(guard.inspect("s", delta("b".repeat(60)))).toBe("trip_oversize");
	});

	it("消息边界重置：新消息重新计数", () => {
		const guard = new StreamGuard({ wsRunBytes: 50, totalBytes: 1000 });
		expect(guard.inspect("s", delta(" ".repeat(60)))).toBe("trip_whitespace");
		expect(guard.inspect("s", boundary("message_end"))).toBe("pass");
		expect(guard.inspect("s", delta("新消息内容"))).toBe("pass");
	});

	it("非 delta 事件与 text_start 等变体直通不计费", () => {
		const guard = new StreamGuard({ wsRunBytes: 10, totalBytes: 10 });
		expect(guard.inspect("s", { type: "agent_start" } as SessionEvent)).toBe("pass");
		expect(
			guard.inspect("s", {
				type: "message_update",
				assistantMessageEvent: { type: "text_start", contentIndex: 0 },
			} as unknown as SessionEvent),
		).toBe("pass");
		// 未 tripped 时 text_start 不受 suppress 影响
		expect(guard.inspect("s", delta("hi"))).toBe("pass");
	});

	it("agent_end/agent_settled 自删状态（subagent 会话不走 closeSession，防 Map 无界增长）", () => {
		const guard = new StreamGuard({ wsRunBytes: 50, totalBytes: 1000 });
		expect(guard.inspect("s", delta(" ".repeat(60)))).toBe("trip_whitespace");
		expect(guard.inspect("s", { type: "agent_end" } as SessionEvent)).toBe("pass");
		// 状态已删：后续 delta 走全新计数（若残留 tripped 状态这里会是 suppress）
		expect(guard.inspect("s", delta("正常"))).toBe("pass");
		expect(guard.inspect("s", { type: "agent_settled" } as SessionEvent)).toBe("pass");
		// 终结事件自身不留条目（run 结束后 Map 归零）
		expect((guard as unknown as { states: Map<string, unknown> }).states.size).toBe(0);
	});

	it("多会话状态隔离 + cleanup", () => {
		const guard = new StreamGuard({ wsRunBytes: 50, totalBytes: 1000 });
		expect(guard.inspect("a", delta(" ".repeat(60)))).toBe("trip_whitespace");
		expect(guard.inspect("b", delta("正常"))).toBe("pass");
		guard.cleanup("a");
		// cleanup 后重新计数，不再 suppress
		expect(guard.inspect("a", delta("重新开始"))).toBe("pass");
	});
});
