import {
	deriveTurnTimings,
	emptyTranscript,
	messagesToUIMessages,
	modelGenerationStats,
	reduceEvent,
	type SessionEvent,
	type UIMessage,
} from "@percho/shared";
import { describe, expect, it } from "vitest";
import { type RawMessage, toSessionMessages } from "../src/session/messages";

const user = { role: "user", content: "检查文件", timestamp: 1000 };
const requests = [
	{
		role: "assistant",
		content: [
			{ type: "text", text: "先读文件" },
			{ type: "toolCall", id: "t1", name: "read", arguments: { path: "readme.md" } },
		],
		usage: { output: 100 },
		durationMs: 1000,
		timestamp: 2000,
		stopReason: "toolUse",
	},
	{
		role: "assistant",
		content: [{ type: "text", text: "检查完成" }],
		usage: { output: 300 },
		durationMs: 9000,
		timestamp: 600_000,
		stopReason: "stop",
	},
];
const event = (type: string, fields: Record<string, unknown> = {}) =>
	({ type, ...fields }) as unknown as SessionEvent;

function liveMessages(replies: readonly RawMessage[] = requests) {
	let state = reduceEvent(emptyTranscript(), event("agent_start"));
	state = reduceEvent(state, event("message_start", { message: user }));
	for (const request of replies) {
		state = reduceEvent(state, event("turn_start"));
		state = reduceEvent(state, event("message_start", { message: request }));
		const blocks = Array.isArray(request.content) ? request.content : [];
		for (const [contentIndex, block] of blocks.entries()) {
			if (block.type === "text") {
				state = reduceEvent(
					state,
					event("message_update", {
						assistantMessageEvent: { type: "text_delta", contentIndex, delta: block.text },
					}),
				);
			} else {
				state = reduceEvent(
					state,
					event("message_update", {
						assistantMessageEvent: { type: "toolcall_start", contentIndex, partial: request },
					}),
				);
				state = reduceEvent(
					state,
					event("message_update", {
						assistantMessageEvent: { type: "toolcall_end", contentIndex, toolCall: block },
					}),
				);
			}
		}
		state = reduceEvent(state, event("turn_end", { message: request }));
		if (request.stopReason === "error") state = reduceEvent(state, event("agent_end", { willRetry: true }));
	}
	return reduceEvent(state, event("agent_settled")).messages;
}

const speed = (messages: UIMessage[]) => deriveTurnTimings(messages)[0]?.outputTokensPerSecond;

describe("轮末平均输出速度的数据链路", () => {
	it("实时事件与历史回放得到相同加权均速；拆分工具不重复计量，不计漫长工具等待", () => {
		const live = liveMessages();
		const history = messagesToUIMessages(toSessionMessages([user, ...requests]));
		expect(speed(live)).toBe(40); // 400 output tokens / 10 seconds of model requests
		expect(speed(history)).toBe(40);
		expect(live.filter((m) => m.kind === "assistant" && m.generation === null)).toHaveLength(1);
		expect(history.filter((m) => m.kind === "assistant" && m.generation === null)).toHaveLength(1);
	});

	it("任一请求统计缺失时隐藏整轮速度，不将部分请求冒充整轮", () => {
		const messages = messagesToUIMessages(
			toSessionMessages([user, requests[0], { ...requests[1], durationMs: undefined }]),
		);
		expect(speed(messages)).toBeUndefined();
		expect(speed(messagesToUIMessages(toSessionMessages([user])))).toBeUndefined();
	});

	it("每个用户轮次独立汇总，前插旧页不改变已知轮次的速度", () => {
		const current = messagesToUIMessages(toSessionMessages([user, ...requests]));
		const older = messagesToUIMessages(
			toSessionMessages([
				{ ...user, timestamp: 1 },
				{ ...requests[1], usage: { output: 20 }, durationMs: 2000, timestamp: 2 },
			]),
		);
		const timings = deriveTurnTimings([...older, ...current]);
		expect(timings.map((t) => t.outputTokensPerSecond)).toEqual([10, 40]);
	});

	it("零 token 请求贡献真实耗时；整轮已知零输出显示零而非缺失", () => {
		const empty = { ...requests[1], content: [], usage: { output: 0 }, durationMs: 1000 };
		expect(speed(messagesToUIMessages(toSessionMessages([user, requests[0], empty])))).toBe(50);
		expect(speed(messagesToUIMessages(toSessionMessages([user, empty])))).toBe(0);
		let state = reduceEvent(emptyTranscript(), event("agent_start"));
		state = reduceEvent(state, event("message_start", { message: user }));
		state = reduceEvent(state, event("turn_end", { message: empty }));
		expect(state.messages[1]).toMatchObject({ generation: { outputTokens: 0, durationMs: 1000 } });
	});

	it("真实空回复缺少统计时，实时和历史都不显示不完整的轮均速", () => {
		const replies: RawMessage[] = [
			...requests,
			{ role: "assistant", content: [], timestamp: 700_000, stopReason: "stop" },
		];
		expect(speed(liveMessages(replies))).toBeUndefined();
		expect(speed(messagesToUIMessages(toSessionMessages([user, ...replies])))).toBeUndefined();
	});

	it("空错误回复重试成功后，实时和历史同样隐藏缺统计的轮均速", () => {
		const replies: RawMessage[] = [
			...requests.slice(0, 1),
			{
				role: "assistant",
				content: [],
				timestamp: 500_000,
				stopReason: "error",
				errorMessage: "429: rate limit",
			},
			...requests.slice(1),
		];
		expect(speed(liveMessages(replies))).toBeUndefined();
		expect(speed(messagesToUIMessages(toSessionMessages([user, ...replies])))).toBeUndefined();
	});

	it.each([NaN, Infinity, -1, "100", undefined])("无效 token 用量 %s 不参与均速", (output) => {
		expect(modelGenerationStats({ usage: { output }, durationMs: 1000 })).toBeUndefined();
	});

	it.each([NaN, Infinity, -1, 0, "1000", undefined])("无效请求耗时 %s 不参与均速", (durationMs) => {
		expect(modelGenerationStats({ usage: { output: 100 }, durationMs })).toBeUndefined();
	});
});
