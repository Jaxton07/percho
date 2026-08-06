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
