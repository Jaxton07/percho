import {
	buildChatRows,
	deriveTurnTimings,
	emptyTranscript,
	type UIMessage,
	type UIToolCall,
} from "@percho/shared";
import { describe, expect, it } from "vitest";

/** noUncheckedIndexedAccess 下的数组取值断言 */
function at<T>(arr: readonly T[], i: number): T {
	const v = arr[i];
	if (v === undefined) throw new Error(`index ${i} out of range`);
	return v;
}

let toolKey = 0;
function tool(name: string, extra: Partial<UIToolCall> = {}): UIToolCall {
	return {
		key: `k${toolKey++}`,
		id: `id${toolKey}`,
		name,
		args: "{}",
		output: "",
		state: "done",
		...extra,
	};
}

function user(id: string, timestamp: number): UIMessage {
	return { kind: "user", id, text: "u", images: [], timestamp };
}

function assistant(id: string, timestamp: number, tools: UIToolCall[] = []): UIMessage {
	return { kind: "assistant", id, text: "a", thinking: "", tools, timestamp };
}

describe("deriveTurnTimings", () => {
	it("空消息 / 无 user 边界 → []", () => {
		expect(deriveTurnTimings([])).toEqual([]);
		expect(deriveTurnTimings([assistant("a1", 100)])).toEqual([]);
	});

	it("单轮正文收尾：startedAt = user timestamp，endedAt = assistant timestamp", () => {
		expect(deriveTurnTimings([user("u1", 1000), assistant("a1", 8000)])).toEqual([
			{ turnIndex: 0, startedAt: 1000, endedAt: 8000 },
		]);
	});

	it("工具收尾轮：endedAt 取 tool.endedAt（晚于 assistant timestamp）", () => {
		const timings = deriveTurnTimings([
			user("u1", 1000),
			assistant("a1", 2000, [tool("bash", { endedAt: 9000 })]),
		]);
		expect(timings).toEqual([{ turnIndex: 0, startedAt: 1000, endedAt: 9000 }]);
	});

	it("多轮边界：各轮独立切分（轮内最大值取结束）", () => {
		const timings = deriveTurnTimings([
			user("u1", 1000),
			assistant("a1", 9000, [tool("bash", { endedAt: 6000 }), tool("read", { endedAt: 9500 })]),
			user("u2", 20000),
			assistant("a2", 25000),
		]);
		expect(timings).toHaveLength(2);
		expect(at(timings, 0)).toEqual({ turnIndex: 0, startedAt: 1000, endedAt: 9500 });
		expect(at(timings, 1)).toEqual({ turnIndex: 1, startedAt: 20000, endedAt: 25000 });
	});

	it("进行中轮（末轮 user 后无内容）：endedAt 缺省", () => {
		const timings = deriveTurnTimings([user("u1", 1000), assistant("a1", 5000), user("u2", 8000)]);
		expect(at(timings, 0)).toEqual({ turnIndex: 0, startedAt: 1000, endedAt: 5000 });
		expect(at(timings, 1)).toEqual({ turnIndex: 1, startedAt: 8000 });
		expect(at(timings, 1).endedAt).toBeUndefined();
	});

	it("runEndedAt 只补最后一轮定格且取 max；早于开始时刻的残留戳被过滤", () => {
		// 定格晚于消息推导 → 采纳
		expect(deriveTurnTimings([user("u1", 1000), assistant("a1", 5000)], 6000)).toEqual([
			{ turnIndex: 0, startedAt: 1000, endedAt: 6000 },
		]);
		// 定格早于消息推导（异常时钟）→ 不回退，保留推导值
		expect(deriveTurnTimings([user("u1", 1000), assistant("a1", 5000)], 4000)).toEqual([
			{ turnIndex: 0, startedAt: 1000, endedAt: 5000 },
		]);
		// 多轮时只动最后一轮
		const multi = deriveTurnTimings(
			[user("u1", 1000), assistant("a1", 5000), user("u2", 10000), assistant("a2", 12000)],
			13000,
		);
		expect(at(multi, 0).endedAt).toBe(5000);
		expect(at(multi, 1).endedAt).toBe(13000);
		// 新轮刚开始、旧 run 戳未清（早于新轮 startedAt）→ 不采纳，新轮视为进行中
		const stale = deriveTurnTimings([user("u1", 1000), assistant("a1", 5000), user("u2", 9000)], 6000);
		expect(at(stale, 1).endedAt).toBeUndefined();
	});

	it("subagent/image 独立消息参与结束时刻；system 消息不参与", () => {
		const timings = deriveTurnTimings([
			user("u1", 1000),
			assistant("a1", 2000),
			{ kind: "subagent", id: "s1", runs: [], timestamp: 7000 },
			{ kind: "system", id: "n1", text: "", timestamp: 7200 },
			{ kind: "image", id: "i1", images: [], paths: [], timestamp: 7500 },
		]);
		expect(at(timings, 0).endedAt).toBe(7500);
	});

	it("用户中止轮：已有消息的推导值即定格（无 runEndedAt 也成立）", () => {
		const timings = deriveTurnTimings([
			user("u1", 1000),
			assistant("a1", 2000, [tool("bash", { endedAt: 3000, state: "done" })]),
		]);
		expect(at(timings, 0).endedAt).toBe(3000);
	});
});

describe("buildChatRows 轮末行（timer 行）", () => {
	it("传 turnTimings 时每轮必产行（无变更轮 = 纯 timer 行）", () => {
		const messages: UIMessage[] = [user("u1", 1000), assistant("a1", 5000)];
		const transcript = { ...emptyTranscript(), messages };
		const rows = buildChatRows(transcript, "s1", Date.now(), {
			turnTimings: deriveTurnTimings(messages),
		});
		const footers = rows.filter((r) => r.kind === "turnDiff");
		expect(footers).toHaveLength(1);
		const footer = at(footers, 0);
		if (footer.kind !== "turnDiff") throw new Error("expected turnDiff");
		expect(footer.changes).toBeUndefined();
		expect(footer.timing).toEqual({ turnIndex: 0, startedAt: 1000, endedAt: 5000 });
		expect(footer.running).toBe(false);
	});

	it("不传 turnTimings 时保持旧行为：有变更才产行", () => {
		const messages: UIMessage[] = [user("u1", 1000), assistant("a1", 5000)];
		const transcript = { ...emptyTranscript(), messages };
		const rows = buildChatRows(transcript, "s1", Date.now(), {});
		expect(rows.filter((r) => r.kind === "turnDiff")).toHaveLength(0);
	});

	it("运行中末轮：running = agentActive（timer 跳动信号），timing 无 endedAt", () => {
		const messages: UIMessage[] = [user("u1", 1000), assistant("a1", 5000), user("u2", 8000)];
		const transcript = { ...emptyTranscript(), messages, agentActive: true };
		const rows = buildChatRows(transcript, "s1", Date.now(), {
			turnTimings: deriveTurnTimings(messages),
		});
		const footers = rows.filter((r) => r.kind === "turnDiff");
		expect(footers).toHaveLength(2);
		const tail = at(footers, footers.length - 1);
		if (tail.kind !== "turnDiff") throw new Error("expected turnDiff");
		expect(tail.running).toBe(true);
		expect(tail.timing).toEqual({ turnIndex: 1, startedAt: 8000 });
	});
});
