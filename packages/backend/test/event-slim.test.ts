import type { SessionEvent } from "@percho/shared";
import { describe, expect, it } from "vitest";
import { slimMessageUpdate } from "../src/session/event-slim";

function update(assistantMessageEvent: Record<string, unknown>): SessionEvent {
	return { type: "message_update", assistantMessageEvent } as unknown as SessionEvent;
}

/** 带 dummy 快照字段的事件（模拟 SDK 原始形状：每条 delta 都带 partial + 顶层 message） */
function rawUpdate(variant: Record<string, unknown>): SessionEvent {
	return update({
		...variant,
		partial: { role: "assistant", content: [{ type: "text", text: "x".repeat(10_000) }] },
	}) as unknown as SessionEvent;
}

describe("slimMessageUpdate", () => {
	it("text/thinking/toolcall delta：保留 type/contentIndex/delta，剥除 partial 与顶层 message", () => {
		const event = {
			...rawUpdate({ type: "text_delta", contentIndex: 2, delta: "你好" }),
			message: { role: "assistant", content: [] },
		} as unknown as SessionEvent;
		const slim = slimMessageUpdate(event) as unknown as Record<string, unknown>;
		expect(slim).toEqual({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 2, delta: "你好" },
		});
	});

	it("toolcall_start：保留 partial（工具名唯一来源）", () => {
		const partial = { content: [{ type: "toolCall", name: "bash" }] };
		const slim = slimMessageUpdate(update({ type: "toolcall_start", contentIndex: 1, partial }));
		expect(slim).toEqual({
			type: "message_update",
			assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, partial },
		});
	});

	it("toolcall_end：保留 toolCall，剥除 partial", () => {
		const toolCall = { id: "call_1", name: "read", arguments: '{"path":"a.ts"}' };
		const slim = slimMessageUpdate(update({ type: "toolcall_end", contentIndex: 1, toolCall }));
		expect(slim).toEqual({
			type: "message_update",
			assistantMessageEvent: { type: "toolcall_end", contentIndex: 1, toolCall },
		});
	});

	it("非 delta 变体（text_end 等）：剥除全量 content，只留 type", () => {
		const slim = slimMessageUpdate(update({ type: "text_end", contentIndex: 0, content: "全文" }));
		expect(slim).toEqual({
			type: "message_update",
			assistantMessageEvent: { type: "text_end" },
		});
	});

	it("非 message_update 事件原样直通（同一引用）", () => {
		const event = { type: "message_end", message: { role: "assistant" } } as unknown as SessionEvent;
		expect(slimMessageUpdate(event)).toBe(event);
	});

	it("瘦身后事件可直接被 reducer 消费（回放/实时同构）", async () => {
		const { emptyTranscript, reduceEvent } = await import("@percho/shared");
		const start = { type: "message_start", message: { role: "assistant", content: [] } };
		let state = reduceEvent(emptyTranscript(), start as never);
		const deltas = ["你", "好", "，", "世", "界"];
		for (const d of deltas) {
			const ev = slimMessageUpdate(rawUpdate({ type: "text_delta", contentIndex: 0, delta: d }));
			state = reduceEvent(state, ev as never);
		}
		expect(state.streaming?.text ?? "").toBe("你好，世界");
	});
});
