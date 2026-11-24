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
	it("重试退避和活动回复的基线都不把已省略的中间尝试显示成最终失败", () => {
		const manager = SessionManager.inMemory();
		const failure = {
			...assistant("partial", 1),
			stopReason: "error",
			errorMessage: "503: temporary",
		} as Message;
		const failedId = manager.appendMessage(failure);
		manager.appendContextEdit(failedId, null);
		const live = new LiveTranscript();
		const emit = (event: unknown) => live.apply(event as SessionEvent, manager.getBranch());
		emit({ type: "turn_end", message: failure, toolResults: [] });
		emit({ type: "agent_end", messages: [], willRetry: true });
		emit({
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 5,
			delayMs: 2000,
			errorMessage: "503: temporary",
		});
		const waiting = live.snapshot(manager.getBranch(), { streaming: false, compacting: false });
		expect(waiting.retrying).not.toBeNull();
		expect(waiting.messages.filter((message) => message.kind === "error")).toHaveLength(0);
		emit({ type: "turn_start" });
		emit({
			type: "message_update",
			assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "recovered" },
		});
		const active = live.snapshot(manager.getBranch(), { streaming: true, compacting: false });
		expect(active.retrying).toBeNull();
		expect(active.messages.filter((message) => message.kind === "error")).toHaveLength(0);
		const recovered = assistant("恢复成功", 2);
		manager.appendMessage(recovered);
		emit({ type: "message_end", message: recovered });
		emit({ type: "auto_retry_end", success: true, attempt: 1 });
		expect(
			live
				.snapshot(manager.getBranch(), { streaming: true, compacting: false })
				.messages.filter((message) => message.kind === "error"),
		).toHaveLength(0);
		emit({ type: "turn_end", message: recovered, toolResults: [] });
		expect(
			live
				.snapshot(manager.getBranch(), { streaming: false, compacting: false })
				.messages.filter((message) => message.kind === "error"),
		).toHaveLength(0);
	});
	it("溢出恢复先省略原消息但压缩失败时，历史基线仍保留真正的最终错误", () => {
		const manager = SessionManager.inMemory();
		const failure = {
			...assistant("", 1),
			stopReason: "error",
			errorMessage: "context_length_exceeded",
		} as Message;
		const failedId = manager.appendMessage(failure);
		const live = new LiveTranscript();
		const emit = (event: unknown) => live.apply(event as SessionEvent, manager.getBranch());
		emit({ type: "turn_end", message: failure, toolResults: [] });
		manager.appendContextEdit(failedId, null);
		emit({ type: "compaction_start", reason: "overflow" });
		expect(
			live
				.snapshot(manager.getBranch(), { streaming: false, compacting: true })
				.messages.filter((message) => message.kind === "error"),
		).toHaveLength(0);
		emit({
			type: "compaction_end",
			reason: "overflow",
			aborted: false,
			willRetry: false,
			errorMessage: "compaction failed",
		});
		emit({ type: "agent_end", messages: [], willRetry: false });
		const final = live.snapshot(manager.getBranch(), { streaming: false, compacting: false });
		expect(final.messages.filter((message) => message.kind === "error")).toHaveLength(1);
	});
	it("新任务或普通压缩不能把旧轮已省略的最终失败当成当前恢复", () => {
		const manager = SessionManager.inMemory();
		const failure = {
			...assistant("", 1),
			stopReason: "error",
			errorMessage: "context_length_exceeded",
		} as Message;
		const failedId = manager.appendMessage(failure);
		manager.appendContextEdit(failedId, null);
		const live = new LiveTranscript();
		const emit = (event: unknown) => live.apply(event as SessionEvent, manager.getBranch());
		emit({ type: "agent_start" });
		emit({ type: "turn_start" });
		const countErrors = (streaming: boolean, compacting = false) =>
			live
				.snapshot(manager.getBranch(), { streaming, compacting })
				.messages.filter((message) => message.kind === "error").length;
		expect(countErrors(true)).toBe(1);
		const user = { role: "user" as const, content: "新任务", timestamp: 2 };
		emit({ type: "message_start", message: user });
		manager.appendMessage(user);
		emit({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "新任务的回复" },
		});
		expect(countErrors(true)).toBe(1);
		emit({ type: "compaction_start", reason: "threshold" });
		expect(countErrors(false, true)).toBe(1);
		// 即使新任务确实开始溢出恢复，也不能跨过仍在瞬态区的新用户边界隐藏旧卡。
		emit({ type: "compaction_start", reason: "overflow" });
		expect(countErrors(false, true)).toBe(1);
	});
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
