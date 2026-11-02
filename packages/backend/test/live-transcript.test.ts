import type { Message } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionEvent } from "@percho/shared";
import { describe, expect, it } from "vitest";
import { LiveTranscript } from "../src/session/live-transcript";
import { SessionSourceSnapshots } from "../src/session/source-snapshot";

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
	it("活动基线的用户附件和未落盘show结果都只带引用，并保持实际SDK用户entry", () => {
		const manager = SessionManager.inMemory();
		const live = new LiveTranscript();
		const emit = (event: unknown) => live.apply(event as SessionEvent, manager.getBranch());
		emit({ type: "agent_start" });
		emit({ type: "turn_start" });
		const user = {
			role: "user" as const,
			timestamp: 1,
			content: [
				{ type: "text" as const, text: "user" },
				{ type: "image" as const, mimeType: "image/png", data: "AQID" },
			],
		};
		emit({ type: "message_start", message: user });
		const userId = manager.appendMessage(user);
		emit({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "working" },
		});
		emit({
			type: "tool_execution_end",
			toolCallId: "real-call",
			toolName: "show_image",
			isError: false,
			result: { content: [], details: { images: [{ mimeType: "image/png", data: "BAUG" }], paths: [] } },
		});
		const sources = new SessionSourceSnapshots();
		const owner = {};
		const view = sources.capture(owner, {
			sessionId: manager.getSessionId(),
			branch: () => manager.getBranch(),
			entries: () => manager.getEntries(),
		});
		const snapshot = live.snapshot(
			manager.getBranch(),
			{ streaming: true, compacting: false },
			(branch) => sources.project(view, true, branch),
			(id, kind, images) => sources.projectTransient(view, id, kind, images),
		);
		const json = JSON.stringify(snapshot);
		expect(json).not.toContain("AQID");
		expect(json).not.toContain("BAUG");
		const row = snapshot.messages.find((message) => message.kind === "user");
		expect(row?.entryId).toBe(userId);
		const pending = snapshot.streaming?.pendingImages[0]?.images[0];
		if (!pending || !("id" in pending)) throw new Error("Missing active source reference");
		expect(sources.resolve(owner, manager.getSessionId(), pending.id, pending.revision).data).toBe("BAUG");
		expect(snapshot.streaming?.text).toBe("working");
		sources.release(owner);
		expect(sources.stats().views).toBe(0);
	});
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
