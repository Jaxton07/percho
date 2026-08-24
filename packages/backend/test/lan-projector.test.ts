import { describe, expect, it, vi } from "vitest";
import { applyEvent, applyPermissionRequest, applyPermissionResolved, seedView } from "../src/lan/projector";

function seeded() {
	return seedView(
		{
			sessionId: "session-1",
			cwd: "/work",
			name: "LAN test",
			active: true,
			messageCount: 1,
			createdAt: 100,
		},
		{ streaming: false, compacting: false },
		[],
		{ inputTokens: 4, outputTokens: 5, cost: 0.01 },
		null,
		null,
	);
}

describe("LAN projector", () => {
	it("projects agent, text, todo tool, and completion events", () => {
		vi.spyOn(Date, "now").mockReturnValue(1000);
		let view = seeded();
		view = applyEvent(view, { type: "agent_start" } as never);
		view = applyEvent(view, {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "hello", contentIndex: 0 },
		} as never);
		view = applyEvent(view, { type: "tool_execution_start", toolName: "todo", toolCallId: "c1" } as never);
		view = applyEvent(view, {
			type: "tool_execution_end",
			toolName: "todo",
			toolCallId: "c1",
			isError: false,
			result: { details: { todos: [{ content: "ship", status: "in_progress" }] } },
		} as never);
		view = applyEvent(view, { type: "agent_end", willRetry: false } as never);

		expect(view).toMatchObject({
			agentActive: false,
			currentTool: null,
			assistantTail: "hello",
			todos: [{ content: "ship", status: "in_progress" }],
			lastActivity: 1000,
		});
	});

	it("keeps only the latest 2KB assistant tail", () => {
		const view = applyEvent(seeded(), {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "a".repeat(2050), contentIndex: 0 },
		} as never);
		expect(view.assistantTail).toBe("a".repeat(2048));
	});

	it("sets and clears the pending permission banner", () => {
		const waiting = applyPermissionRequest(seeded(), {
			id: "perm-1",
			sessionId: "session-1",
			title: "Allow edit",
			message: "outside workspace",
			kind: "path",
		});
		expect(waiting.pendingPermission).toEqual({
			title: "Allow edit",
			message: "outside workspace",
			kind: "path",
		});
		expect(applyPermissionResolved(waiting).pendingPermission).toBeNull();
	});
});
