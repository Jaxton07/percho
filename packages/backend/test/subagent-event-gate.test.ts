import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionEvent } from "@percho/shared";
import { describe, expect, it, vi } from "vitest";
import { PiBackend } from "../src/pi-backend";
import type { LiveTranscript } from "../src/session/live-transcript";
import type { RegisteredSession, SessionRegistry } from "../src/session/registry";
import type { SessionTraces } from "../src/session/traces";

describe("子会话转发闸门", () => {
	it("检视副本打开后，运行中历史取真分支，结束后读盘取得新增历史", async () => {
		const parent = resolve("../../.local/tmp/subagent-dev-capability");
		mkdirSync(parent, { recursive: true });
		const root = mkdtempSync(join(parent, "branch-"));
		const manager = SessionManager.create(root, root);
		manager.appendMessage({ role: "user", content: "initial", timestamp: 1 });
		manager.appendMessage({
			role: "assistant",
			api: "openai-completions",
			provider: "test",
			model: "offline",
			timestamp: 2,
			content: [{ type: "text", text: "first" }],
			stopReason: "stop",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		const stale = SessionManager.open(manager.getSessionFile() as string);
		manager.appendMessage({ role: "user", content: "added after opening", timestamp: 3 });
		const backend = new PiBackend();
		const internal = backend as unknown as {
			registry: SessionRegistry;
			runningSubagents: Map<string, { getBranch: () => ReturnType<SessionManager["getBranch"]> }>;
		};
		vi.spyOn(internal.registry, "get").mockReturnValue({
			readOnly: true,
			session: { sessionId: "child", sessionFile: manager.getSessionFile(), sessionManager: stale },
		} as RegisteredSession);
		try {
			internal.runningSubagents.set("child", { getBranch: () => manager.getBranch() });
			expect(JSON.stringify(await backend.getSessionMessages("child"))).toContain("added after opening");
			internal.runningSubagents.delete("child");
			expect(JSON.stringify(await backend.getSessionMessages("child"))).toContain("added after opening");
		} finally {
			backend.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("只有当前检视的子代理推详细事件；切回父会话后基线照常记录，父会话事件不受影响", () => {
		const backend = new PiBackend();
		const internal = backend as unknown as {
			emitEvent: (
				id: string,
				event: SessionEvent,
				options: { forward: boolean; recordTrace: boolean },
			) => void;
			emitSubagentEvent: (id: string, event: SessionEvent, abort: () => Promise<void>) => void;
			liveTranscripts: Map<string, LiveTranscript>;
			traces: SessionTraces;
			registry: SessionRegistry;
		};
		const emit = (event: SessionEvent) => internal.emitSubagentEvent("child", event, async () => {});
		const forwarded: SessionEvent[] = [];
		backend.onEvent((_id, event) => forwarded.push(event));
		const trace = vi.spyOn(internal.traces, "record");
		emit({ type: "agent_start" });
		emit({ type: "turn_start" } as SessionEvent);
		emit({
			type: "message_start",
			message: { role: "assistant", content: [], timestamp: 1 },
		} as SessionEvent);
		emit({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "in progress" },
		} as SessionEvent);
		expect(forwarded).toEqual([]);
		expect(
			JSON.stringify(
				internal.liveTranscripts.get("child")?.snapshot([], { streaming: true, compacting: false }),
			),
		).toContain("in progress");
		vi.spyOn(internal.registry, "has").mockReturnValue(true);
		emit({ type: "agent_settled", aborted: false } as SessionEvent);
		expect(forwarded).toHaveLength(0); // 已打开但未检视，仍不转发
		backend.setViewedSubagent("child");
		emit({ type: "agent_settled", aborted: false } as SessionEvent);
		expect(forwarded.map((e) => e.type)).toEqual(["agent_settled"]);
		backend.setViewedSubagent();
		emit({ type: "agent_settled", aborted: false } as SessionEvent);
		expect(forwarded).toHaveLength(1);
		backend.setViewedSubagent("other-child");
		emit({ type: "agent_start" });
		expect(forwarded).toHaveLength(1);
		expect(internal.liveTranscripts.get("child")?.sequence).toBeGreaterThan(6);
		backend.setViewedSubagent("child");
		emit({ type: "agent_settled", aborted: false } as SessionEvent);
		expect(forwarded).toHaveLength(2);
		vi.mocked(internal.registry.has).mockReturnValue(false);
		emit({ type: "agent_settled", aborted: false } as SessionEvent);
		expect(forwarded).toHaveLength(2);
		expect(trace).not.toHaveBeenCalled();
		internal.emitEvent("parent", { type: "tool_execution_update" } as SessionEvent, {
			forward: true,
			recordTrace: false,
		});
		expect(forwarded.at(-1)?.type).toBe("tool_execution_update");
		backend.dispose();
	});

	it("未打开会话流式熔断调用 runner 提供的中止句柄", async () => {
		const backend = new PiBackend();
		const internal = backend as unknown as {
			emitEvent: (
				id: string,
				event: SessionEvent,
				options: { forward: boolean; recordTrace: boolean; abort: () => Promise<void> },
			) => void;
		};
		const abort = vi.fn(async () => {}),
			forwarded = vi.fn();
		backend.onEvent(forwarded);
		internal.emitEvent(
			"unopened",
			{
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " ".repeat(9000) },
			} as SessionEvent,
			{ forward: false, recordTrace: false, abort },
		);
		expect(abort).toHaveBeenCalledOnce();
		expect(forwarded).not.toHaveBeenCalled();
		backend.dispose();
	});
});
