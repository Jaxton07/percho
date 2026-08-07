import type { AgentSessionEvent } from "@pi-desktop/shared";
import { describe, expect, it } from "vitest";
import { emptyTranscript, reduceEvent } from "./transcript-reducer";

function ev(type: string, extra: Record<string, unknown> = {}): AgentSessionEvent {
	return { type, ...extra } as AgentSessionEvent;
}

describe("transcript reducer", () => {
	it("用户消息经 message_start 进入消息流", () => {
		let state = emptyTranscript();
		state = reduceEvent(state, {
			type: "message_start",
			message: { role: "user", content: [{ type: "text", text: "你好" }] },
		} as unknown as AgentSessionEvent);
		expect(state.messages).toHaveLength(1);
		expect(state.messages[0]).toMatchObject({ kind: "user", text: "你好" });
	});

	it("message_start 提取图片块为 images", () => {
		let state = emptyTranscript();
		state = reduceEvent(state, {
			type: "message_start",
			message: {
				role: "user",
				content: [
					{ type: "image", data: "AAAA", mimeType: "image/png" },
					{ type: "text", text: "看图" },
				],
			},
		} as unknown as AgentSessionEvent);
		expect(state.messages).toHaveLength(1);
		expect(state.messages[0]).toMatchObject({
			kind: "user",
			text: "看图",
			images: [{ data: "AAAA", mimeType: "image/png" }],
		});
	});

	it("agent_start 进入流式，text_delta 累积", () => {
		let state = emptyTranscript();
		state = reduceEvent(state, ev("agent_start"));
		expect(state.phase).toBe("streaming");
		state = reduceEvent(state, {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello" },
		} as unknown as AgentSessionEvent);
		state = reduceEvent(state, {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " world" },
		} as unknown as AgentSessionEvent);
		expect(state.streaming?.text).toBe("Hello world");
	});

	it("turn_end 固化为 assistant 消息并回到 idle", () => {
		let state = emptyTranscript();
		state = reduceEvent(state, ev("agent_start"));
		state = reduceEvent(state, {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hi" },
		} as unknown as AgentSessionEvent);
		state = reduceEvent(state, ev("turn_end"));
		expect(state.phase).toBe("idle");
		expect(state.streaming).toBeNull();
		expect(state.messages).toHaveLength(1);
		expect(state.messages[0]).toMatchObject({ kind: "assistant", text: "Hi" });
	});

	it("toolcall 事件累积为工具卡片，tool_execution_* 流式输出", () => {
		let state = emptyTranscript();
		state = reduceEvent(state, ev("agent_start"));
		state = reduceEvent(state, {
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_start",
				contentIndex: 0,
				partial: { toolCalls: [{ name: "bash" }] },
			},
		} as unknown as AgentSessionEvent);
		state = reduceEvent(state, {
			type: "message_update",
			assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: '{"command":"ls"}' },
		} as unknown as AgentSessionEvent);
		state = reduceEvent(state, {
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 0,
				toolCall: { id: "tc1", name: "bash", arguments: { command: "ls" } },
			},
		} as unknown as AgentSessionEvent);
		expect(state.streaming?.tools).toHaveLength(1);
		expect(state.streaming?.tools[0]).toMatchObject({ id: "tc1", name: "bash" });

		state = reduceEvent(state, {
			type: "tool_execution_start",
			toolCallId: "tc1",
			toolName: "bash",
			args: { command: "ls" },
		} as unknown as AgentSessionEvent);
		state = reduceEvent(state, {
			type: "tool_execution_update",
			toolCallId: "tc1",
			toolName: "bash",
			args: {},
			partialResult: { output: "a.txt\nb.txt" },
		} as unknown as AgentSessionEvent);
		state = reduceEvent(state, {
			type: "tool_execution_end",
			toolCallId: "tc1",
			toolName: "bash",
			result: {},
			isError: false,
		} as unknown as AgentSessionEvent);
		const tool = state.streaming?.tools[0];
		expect(tool?.state).toBe("done");
		expect(tool?.output).toContain("a.txt");

		state = reduceEvent(state, ev("turn_end"));
		expect(state.messages[0]).toMatchObject({ kind: "assistant" });
	});

	it("并行两个 toolcall：contentIndex 交错时按块匹配，两个都能 done", () => {
		let state = emptyTranscript();
		state = reduceEvent(state, ev("agent_start"));
		// ci=0 与 ci=1 各自 start
		state = reduceEvent(state, {
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_start",
				contentIndex: 0,
				partial: { content: [{ type: "toolCall", name: "bash" }] },
			},
		} as unknown as AgentSessionEvent);
		state = reduceEvent(state, {
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_start",
				contentIndex: 1,
				partial: {
					content: [
						{ type: "toolCall", name: "bash" },
						{ type: "toolCall", name: "grep" },
					],
				},
			},
		} as unknown as AgentSessionEvent);
		// delta 交错到来（SDK 保证事件可按任意块交错）
		state = reduceEvent(state, {
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_delta",
				contentIndex: 1,
				delta: '{"pattern":"ui"',
			},
		} as unknown as AgentSessionEvent);
		state = reduceEvent(state, {
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_delta",
				contentIndex: 0,
				delta: '{"command":"ls"',
			},
		} as unknown as AgentSessionEvent);
		// end 交错：先 ci=1 再 ci=0
		state = reduceEvent(state, {
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 1,
				toolCall: { id: "call_b", name: "grep", arguments: { pattern: "ui" } },
			},
		} as unknown as AgentSessionEvent);
		state = reduceEvent(state, {
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 0,
				toolCall: { id: "call_a", name: "bash", arguments: { command: "ls" } },
			},
		} as unknown as AgentSessionEvent);
		expect(state.streaming?.tools).toHaveLength(2);
		expect(state.streaming?.tools[0]).toMatchObject({ id: "call_a", name: "bash" });
		expect(state.streaming?.tools[1]).toMatchObject({ id: "call_b", name: "grep" });
		// 执行事件各自匹配
		state = reduceEvent(state, {
			type: "tool_execution_end",
			toolCallId: "call_b",
			toolName: "grep",
			result: {},
			isError: false,
		} as unknown as AgentSessionEvent);
		state = reduceEvent(state, {
			type: "tool_execution_end",
			toolCallId: "call_a",
			toolName: "bash",
			result: {},
			isError: false,
		} as unknown as AgentSessionEvent);
		expect(state.streaming?.tools.every((t) => t.state === "done")).toBe(true);
	});

	it("agent_end willRetry 保持流式，无重试回到 idle", () => {
		let state = emptyTranscript();
		state = reduceEvent(state, ev("agent_start"));
		state = reduceEvent(state, {
			type: "agent_end",
			messages: [],
			willRetry: true,
		} as unknown as AgentSessionEvent);
		expect(state.phase).toBe("streaming");
		state = reduceEvent(state, {
			type: "agent_end",
			messages: [],
			willRetry: false,
		} as unknown as AgentSessionEvent);
		expect(state.phase).toBe("idle");
	});
});
