import type { AgentSessionEvent, SessionMessage } from "@percho/shared";
import { emptyTranscript, messagesToUIMessages, reduceEvent } from "@percho/shared";
import { describe, expect, it } from "vitest";

type Event = AgentSessionEvent;
const turnEnd = (stopReason: string, errorMessage?: string): Event =>
	({
		type: "turn_end",
		message: { role: "assistant", stopReason, errorMessage },
		toolResults: [],
	}) as unknown as Event;
const agentEnd = (willRetry: boolean): Event => ({ type: "agent_end", messages: [], willRetry });
const settled: Event = { type: "agent_settled" };
const guard: Event = { type: "stream_guard_tripped", verdict: "trip_whitespace" } as unknown as Event;

const errorCards = (s: ReturnType<typeof emptyTranscript>) => s.messages.filter((m) => m.kind === "error");

describe("reducer — LLM 错误卡（决策 D1：agent_end 落卡）", () => {
	it("单次失败：turn_end(error) → agent_end(willRetry=false) 恰好一张卡", () => {
		let s = reduceEvent(emptyTranscript(), turnEnd("error", '401: {"message":"Invalid API key provided"}'));
		expect(errorCards(s)).toHaveLength(0); // pending 待判定
		s = reduceEvent(s, agentEnd(false));
		const cards = errorCards(s);
		expect(cards).toHaveLength(1);
		const card = cards[0];
		expect(card).toMatchObject({ kind: "error", text: "" });
		if (card?.kind !== "error") return;
		expect(card.error).toMatchObject({
			severity: "error",
			source: "llm",
			titleKey: "error.title.llmAuth",
			detail: '401: {"message":"Invalid API key provided"}',
		});
		expect(card.error.actions).toContain("retry");
		expect(card.error.actions).toContain("copyDetail");
	});

	it("重试成功：error → willRetry=true 丢弃 → 成功轮 → 无卡", () => {
		let s = reduceEvent(emptyTranscript(), turnEnd("error", "429: rate limit"));
		s = reduceEvent(s, agentEnd(true));
		expect(errorCards(s)).toHaveLength(0);
		s = reduceEvent(s, turnEnd("stop"));
		s = reduceEvent(s, agentEnd(false));
		expect(errorCards(s)).toHaveLength(0);
		expect(s.pendingLlmError).toBeNull();
	});

	it("重试耗尽：3 个 error 轮只落最后一张", () => {
		let s = reduceEvent(emptyTranscript(), turnEnd("error", "429: attempt 1"));
		s = reduceEvent(s, agentEnd(true));
		s = reduceEvent(s, turnEnd("error", "429: attempt 2"));
		s = reduceEvent(s, agentEnd(true));
		s = reduceEvent(s, turnEnd("error", "429: attempt 3"));
		s = reduceEvent(s, agentEnd(false));
		const cards = errorCards(s);
		expect(cards).toHaveLength(1);
		if (cards[0]?.kind === "error") {
			expect(cards[0].error.detail).toContain("attempt 3"); // 最后一条错误
		}
	});

	it("aborted 不产卡（用户主动中止）", () => {
		let s = reduceEvent(emptyTranscript(), turnEnd("aborted"));
		s = reduceEvent(s, agentEnd(false));
		expect(errorCards(s)).toHaveLength(0);
	});

	it("error + abort 文案不产卡（用户主动中止时 SDK 标成 error 的实测形态）", () => {
		// DOMException AbortError：中断工具执行后，agent loop 继续发起的 in-flight 请求被取消
		let s = reduceEvent(emptyTranscript(), turnEnd("error", "This operation was aborted"));
		s = reduceEvent(s, agentEnd(false));
		expect(errorCards(s)).toHaveLength(0);
		expect(s.pendingLlmError).toBeNull();
		// SDK 上层另一种中止形态
		s = reduceEvent(emptyTranscript(), turnEnd("error", "Request aborted"));
		s = reduceEvent(s, agentEnd(false));
		expect(errorCards(s)).toHaveLength(0);
	});

	it("含 abort 字样但非取消语义的错误仍产卡（判定只看文案，detail 不丢）", () => {
		let s = reduceEvent(emptyTranscript(), turnEnd("error", "provider aborted the request: 503"));
		s = reduceEvent(s, agentEnd(false));
		expect(errorCards(s)).toHaveLength(1);
	});

	it("errorMessage 为空串不产卡（防御）", () => {
		let s = reduceEvent(emptyTranscript(), turnEnd("error", ""));
		s = reduceEvent(s, agentEnd(false));
		expect(errorCards(s)).toHaveLength(0);
	});

	it("agent_settled 兜底：agent_end 缺失时 pending 仍落卡", () => {
		let s = reduceEvent(emptyTranscript(), turnEnd("error", "timeout"));
		s = reduceEvent(s, settled);
		expect(errorCards(s)).toHaveLength(1);
	});
});

describe("reducer — auto_retry 瞬时状态（retrying）", () => {
	it("auto_retry_start → 状态行数据齐全；auto_retry_end 清除", () => {
		let s = reduceEvent(emptyTranscript(), {
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 2,
			delayMs: 8000,
			errorMessage: "429: x",
		});
		expect(s.retrying).toEqual({ attempt: 1, maxAttempts: 2, delayMs: 8000 });
		s = reduceEvent(s, { type: "auto_retry_end", success: true, attempt: 1, finalError: undefined });
		expect(s.retrying).toBeNull();
	});

	it("retry 轮继续（turn_start/turn_end）不清除状态行（实测：auto_retry_start 后紧接重试轮）", () => {
		let s = reduceEvent(emptyTranscript(), {
			type: "auto_retry_start",
			attempt: 2,
			maxAttempts: 2,
			delayMs: 300,
			errorMessage: "429: x",
		});
		s = reduceEvent(s, { type: "turn_start" });
		expect(s.retrying).not.toBeNull();
	});

	it("agent_settled 兜底清除", () => {
		let s = reduceEvent(emptyTranscript(), {
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 1,
			delayMs: 10,
			errorMessage: "x",
		});
		s = reduceEvent(s, settled);
		expect(s.retrying).toBeNull();
	});
});

describe("reducer — stream_guard_tripped", () => {
	it("产 warning 卡（verdict 进 detail），并在正文之后", () => {
		// 先有一轮正常正文流（turn_start + text delta + turn_end 固化）
		let s = reduceEvent(emptyTranscript(), { type: "agent_start" });
		s = reduceEvent(s, { type: "turn_start" });
		s = reduceEvent(s, {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "部分正文", contentIndex: 0 },
		} as unknown as Event);
		s = reduceEvent(s, turnEnd("stop"));
		const before = s.messages.length;
		s = reduceEvent(s, guard);
		const cards = errorCards(s);
		expect(cards).toHaveLength(1);
		expect(cards[0]).toMatchObject({ kind: "error", text: "" });
		if (cards[0]?.kind !== "error") return;
		expect(cards[0].error).toMatchObject({ severity: "warning", titleKey: "error.title.streamGuard" });
		expect(cards[0].error.detail).toContain("trip_whitespace");
		expect(cards[0].error.actions).toEqual(["retry", "copyDetail"]);
		// 落在正文消息之后
		expect(s.messages[before]).toMatchObject({ kind: "error" });
	});

	it("清除同轮 pending LLM 错误（熔断卡是唯一解释）", () => {
		let s = reduceEvent(emptyTranscript(), turnEnd("error", "429: xxx"));
		s = reduceEvent(s, guard);
		expect(errorCards(s)).toHaveLength(1);
		expect(s.pendingLlmError).toBeNull();
		// 后续 agent_end(willRetry=false) 不再落 LLM 卡
		s = reduceEvent(s, agentEnd(false));
		expect(errorCards(s)).toHaveLength(1);
	});
});

describe("mapping — 历史回放产卡（连续 error 合并）", () => {
	const asst = (stopReason: string, errorMessage?: string, text = ""): SessionMessage =>
		({
			role: "assistant",
			text,
			thinking: "",
			tools: [],
			images: [],
			timestamp: 1,
			...(stopReason ? { stopReason } : {}),
			...(errorMessage ? { errorMessage } : {}),
		}) as SessionMessage;

	it("1 user + 3 连续 error assistant → 一张卡（重试轮合并）", () => {
		const ui = messagesToUIMessages([
			{ role: "user", text: "hi", thinking: "", tools: [], images: [], timestamp: 0 },
			asst("error", "429: attempt 1"),
			asst("error", "429: attempt 2"),
			asst("error", "429: attempt 3"),
		]);
		const cards = ui.filter((m) => m.kind === "error");
		expect(cards).toHaveLength(1);
		expect(cards[0]).toMatchObject({ kind: "error", text: "" });
		if (cards[0]?.kind === "error") expect(cards[0].error.detail).toContain("attempt 3");
	});

	it("partial 正文 + error：正文消息在前，错误卡在后", () => {
		const ui = messagesToUIMessages([asst("error", "429: rate limit", "我正准备…")]);
		expect(ui).toHaveLength(2);
		expect(ui[0]).toMatchObject({ kind: "assistant", text: "我正准备…" });
		expect(ui[1]).toMatchObject({ kind: "error" });
	});

	it("error 与正常回复交错：各自落卡（不误合并）", () => {
		const ui = messagesToUIMessages([
			asst("error", "401: auth"),
			asst("stop", undefined, "正常回复"),
			asst("error", "429: again"),
		]);
		const cards = ui.filter((m) => m.kind === "error");
		expect(cards).toHaveLength(2);
	});

	it("aborted / 正常完成不产卡；无 errorMessage 的错误不产卡", () => {
		expect(messagesToUIMessages([asst("aborted", undefined, "被中止")])).toHaveLength(1);
		const noMsg = messagesToUIMessages([asst("error")]); // backend 不会产出此类消息（无内容且无错误信息），防御不产卡
		expect(noMsg.filter((m) => m.kind === "error")).toHaveLength(0);
		expect(messagesToUIMessages([asst("stop", undefined, "ok")])).toHaveLength(1);
	});

	it("error + abort 文案不产卡（回放与 live 同判定）", () => {
		// DOMException / SDK 中止文案：已落盘的空 assistant 消息回放时不冒错误卡
		expect(
			messagesToUIMessages([asst("error", "This operation was aborted")]).filter((m) => m.kind === "error"),
		).toHaveLength(0);
		expect(
			messagesToUIMessages([asst("error", "Request aborted")]).filter((m) => m.kind === "error"),
		).toHaveLength(0);
	});

	it("分类：401 → llmAuth / context overflow → llmOverflow（回放与 live 同判定）", () => {
		const ui401 = messagesToUIMessages([asst("error", "401: unauthorized")]);
		const uiOverflow = messagesToUIMessages([asst("error", "context_length_exceeded")]);
		if (ui401[0]?.kind === "error") expect(ui401[0].error.titleKey).toBe("error.title.llmAuth");
		if (uiOverflow[0]?.kind === "error") expect(uiOverflow[0].error.titleKey).toBe("error.title.llmOverflow");
	});
});
