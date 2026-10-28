import type { Message } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionEvent } from "@percho/shared";
import { describe, expect, it } from "vitest";
import { LiveTranscript } from "../src/session/live-transcript";

const assistant = (text: string, timestamp: number) =>
	({
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "fixture",
		model: "m",
		timestamp,
		stopReason: "stop",
	}) as Message;

describe("current-turn baseline projection", () => {
	it("joins a complete compacted branch to unfinished text/tools once, then observes branch/recall changes", () => {
		const manager = SessionManager.inMemory();
		const first = manager.appendMessage({ role: "user", content: "old request", timestamp: 1 });
		manager.appendMessage(assistant("old answer", 2));
		manager.appendCompaction("compact summary", first, 100);
		const live = new LiveTranscript();
		const emit = (event: unknown) => live.apply(event as SessionEvent, manager.getBranch());
		emit({ type: "agent_start" });
		emit({ type: "turn_start" });
		const user = { role: "user", content: "new request", timestamp: 3 } as const;
		emit({ type: "message_start", message: user });
		manager.appendMessage(user);
		emit({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "partial answer" },
		});
		emit({
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_start",
				contentIndex: 1,
				partial: { toolCalls: [{ name: "bash" }] },
			},
		});
		emit({
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 1,
				toolCall: { id: "tool", name: "bash", arguments: { command: "echo test" } },
			},
		});
		emit({
			type: "tool_execution_start",
			toolCallId: "tool",
			toolName: "bash",
			args: { command: "echo test" },
		});
		emit({
			type: "tool_execution_update",
			toolCallId: "tool",
			toolName: "bash",
			args: {},
			partialResult: "working",
		});
		// SDK has persisted the assistant before all its tools finish. It must not appear twice.
		manager.appendMessage(assistant("partial answer", 4));
		const captured = live.snapshot(manager.getBranch(), { streaming: true, compacting: false });
		expect(
			captured.messages.filter((message) => message.kind === "user").map((message) => message.text),
		).toEqual(["old request", "new request"]);
		expect(
			captured.messages.some(
				(message) => message.kind === "system" && message.compact?.summary === "compact summary",
			),
		).toBe(true);
		expect(captured.messages.filter((message) => message.text === "partial answer")).toHaveLength(0);
		expect(captured.streaming?.text).toBe("partial answer");
		expect(captured.streaming?.tools.find((tool) => tool.id === "tool")).toMatchObject({
			state: "running",
			output: "working",
		});
		const boundary = live.sequence;
		emit({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " continued" },
		});
		expect(live.sequence).toBe(boundary + 1);
		expect(captured.streaming?.text).toBe("partial answer");
		emit({ type: "turn_end", message: assistant("partial answer", 4), toolResults: [] });
		emit({ type: "agent_settled", aborted: false });
		const finished = live.snapshot(manager.getBranch(), { streaming: false, compacting: false });
		expect(finished.messages.filter((message) => message.text === "partial answer")).toHaveLength(1);
		expect(finished.streaming).toBeNull();
		manager.branch(first);
		const recalled = live.snapshot(manager.getBranch(), { streaming: false, compacting: false });
		expect(recalled.messages.map((message) => message.text)).toEqual(["old request"]);
	});
});
