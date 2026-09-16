import { describe, expect, it, vi } from "vitest";
import {
	applyEvent,
	applyPermissionRequest,
	applyPermissionResolved,
	deriveView,
	sanitizeProjectionForWire,
	seedProjection,
} from "../src/lan/projector";

function seeded() {
	return seedProjection(
		"session-1",
		"LAN test",
		"/work",
		{ streaming: false, compacting: false },
		[],
		{ inputTokens: 4, outputTokens: 5, cost: 0.01 },
		[],
		null,
	);
}

describe("LAN projector（D6：reducer 态 + 派生视图）", () => {
	it("projects agent, text, todo tool, and completion events", () => {
		vi.spyOn(Date, "now").mockReturnValue(1000);
		let projection = seeded();
		projection = applyEvent(projection, { type: "agent_start" } as never);
		projection = applyEvent(projection, {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "hello", contentIndex: 0 },
		} as never);
		projection = applyEvent(projection, {
			type: "tool_execution_start",
			toolName: "todo",
			toolCallId: "c1",
		} as never);
		projection = applyEvent(projection, {
			type: "tool_execution_end",
			toolName: "todo",
			toolCallId: "c1",
			isError: false,
			result: { details: { todos: [{ content: "ship", status: "in_progress" }] } },
		} as never);
		projection = applyEvent(projection, { type: "agent_end", willRetry: false } as never);

		expect(deriveView("session-1", projection)).toMatchObject({
			agentActive: false,
			currentTool: null,
			assistantTail: "hello",
			todos: [{ content: "ship", status: "in_progress" }],
			lastActivity: 1000,
		});
	});

	it("keeps only the latest 2KB assistant tail", () => {
		let projection = applyEvent(seeded(), { type: "agent_start" } as never);
		projection = applyEvent(projection, {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "a".repeat(2050), contentIndex: 0 },
		} as never);
		expect(deriveView("session-1", projection).assistantTail).toBe("a".repeat(2048));
	});

	it("sets and clears the pending permission banner", () => {
		const waiting = applyPermissionRequest(seeded(), {
			id: "perm-1",
			sessionId: "session-1",
			title: "Allow edit",
			message: "outside workspace",
			kind: "path",
		});
		expect(deriveView("session-1", waiting).pendingPermission).toEqual({
			title: "Allow edit",
			message: "outside workspace",
			kind: "path",
		});
		expect(deriveView("session-1", applyPermissionResolved(waiting)).pendingPermission).toBeNull();
	});

	it("snapshot wire 净化：剥 sourceText + 尾部截断标记", () => {
		let projection = seeded();
		projection = applyEvent(projection, {
			type: "message_start",
			message: { role: "user", content: "hi", sourceText: "secret" },
		} as never);
		const wire = sanitizeProjectionForWire(projection, 1);
		expect(wire.truncated).toBe(false);
		expect(wire.state.messages).toHaveLength(1);
	});
});
