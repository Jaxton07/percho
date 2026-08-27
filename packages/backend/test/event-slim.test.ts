import type { SessionEvent } from "@percho/shared";
import { describe, expect, it } from "vitest";
import { slimBulkyEvent, slimMessageUpdate } from "../src/session/event-slim";

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

describe("slimBulkyEvent（toolResult 终态载荷瘦身）", () => {
	const bigImage = { type: "image", data: "A".repeat(503_260), mimeType: "image/png" };
	const bigText = { type: "text", text: "x".repeat(100_000) };
	const smallText = { type: "text", text: "normal output" };

	it("tool_execution_end：image base64 剥除换占位、超长 text 截断保头、details 原样保留", () => {
		const event = {
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "read",
			isError: false,
			result: { content: [smallText, bigImage, bigText], details: { patch: "keep me" } },
		} as unknown as SessionEvent;
		const slim = slimBulkyEvent(event) as unknown as {
			result: { content: Array<{ type: string; data?: string; text?: string }>; details: unknown };
		};
		expect(slim.result.content[0]).toBe(smallText);
		expect(slim.result.content[1].data).toBe("[image data stripped: 503260B]");
		expect(slim.result.content[1].type).toBe("image");
		expect(slim.result.content[2].text.startsWith("xxxx")).toBe(true);
		expect(slim.result.content[2].text.length).toBeLessThan(5_000);
		expect(slim.result.content[2].text).toContain("[tool output truncated: kept 4KB of 100000B]");
		expect(slim.result.details).toEqual({ patch: "keep me" });
	});

	it("message_start/message_end 仅对 toolResult 角色瘦身；assistant/user 原样返回", () => {
		const toolResultMsg = { role: "toolResult", content: [bigImage] };
		const assistantMsg = { role: "assistant", content: [{ type: "text", text: "y".repeat(200_000) }] };
		const end = { type: "message_end", message: toolResultMsg } as unknown as SessionEvent;
		const slim = slimBulkyEvent(end) as unknown as { message: { content: Array<{ data: string }> } };
		expect(slim.message.content[0].data).toBe("[image data stripped: 503260B]");
		const keep = { type: "message_end", message: assistantMsg } as unknown as SessionEvent;
		expect(slimBulkyEvent(keep)).toBe(keep);
	});

	it("turn_end：toolResults 逐个瘦身，message（assistant 终态）不动", () => {
		const event = {
			type: "turn_end",
			turnIndex: 3,
			message: { role: "assistant", content: [{ type: "text", text: "z".repeat(300_000) }] },
			toolResults: [
				{ role: "toolResult", content: [bigImage] },
				{ role: "toolResult", content: [smallText] },
			],
		} as unknown as SessionEvent;
		const slim = slimBulkyEvent(event) as unknown as {
			message: unknown;
			toolResults: Array<{ content: Array<{ data?: string }> }>;
		};
		expect(slim.message).toBe((event as { message: unknown }).message);
		expect(slim.toolResults[0].content[0].data).toBe("[image data stripped: 503260B]");
		expect(slim.toolResults[1].content[0]).toBe(smallText);
	});

	it("小载荷零拷贝：引用相等（无截断/剥离发生时返回原事件）", () => {
		const event = {
			type: "tool_execution_end",
			toolCallId: "t2",
			toolName: "bash",
			isError: true,
			result: { content: [smallText], error: "boom" },
		} as unknown as SessionEvent;
		expect(slimBulkyEvent(event)).toBe(event);
	});

	it("message_update / 其他事件类型直通", () => {
		const event = { type: "queue_update", followUp: [] } as unknown as SessionEvent;
		expect(slimBulkyEvent(event)).toBe(event);
	});
});
