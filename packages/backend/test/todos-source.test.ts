import type { Message } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { PiBackend } from "../src/pi-backend";
import type { SessionRegistry } from "../src/session/registry";

/**
 * getTodos 的数据源是**会话分支**（getBranch()），不是压缩后的请求投影
 * （1.0.4 起 `session.messages` = agent.state.messages = 压缩后的 wire）。
 * 症状回归：压缩一发生，TodoPanel 就空、只能等 todo-reminder 兜底。
 */
function todoResult(todos: { content: string; status: string }[]): Message {
	return {
		role: "toolResult",
		toolCallId: "c1",
		toolName: "todo",
		content: [{ type: "text", text: "ok" }],
		details: { todos },
		isError: false,
		timestamp: 2,
	} as unknown as Message;
}

function makeBackend(sm: SessionManager): PiBackend {
	const backend = new PiBackend({ projectTrust: false, permissionGates: false });
	const registry = (backend as unknown as { registry: SessionRegistry }).registry;
	registry.add({
		session: { sessionId: "s1", sessionManager: sm } as unknown as AgentSession,
		unsubscribe: () => {},
		cwd: "/tmp",
	});
	return backend;
}

describe("PiBackend.getTodos 数据源 = 会话分支", () => {
	it("读分支上最后一条 todo 工具结果的 details", async () => {
		const sm = SessionManager.inMemory();
		sm.appendMessage({ role: "user", content: "开工", timestamp: 1 } satisfies Message);
		sm.appendMessage(todoResult([{ content: "第一步", status: "completed" }]));
		sm.appendMessage(todoResult([{ content: "第二步", status: "in_progress" }]));

		// 故意让公开投影（压缩后的 wire）里没有这条 toolResult
		const backend = makeBackend(sm);
		expect(await backend.getTodos("s1")).toEqual([{ content: "第二步", status: "in_progress" }]);
	});

	it("压缩发生后仍能读出列表（分支保留被压缩掉的 entry）", async () => {
		const sm = SessionManager.inMemory();
		sm.appendMessage({ role: "user", content: "开工", timestamp: 1 } satisfies Message);
		sm.appendMessage(todoResult([{ content: "写测试", status: "in_progress" }]));
		const keepFrom = sm.appendMessage({ role: "user", content: "继续", timestamp: 3 } satisfies Message);
		// 以 todo 结果**之后**的 entry 为保留起点压缩：投影里那条 toolResult 被裁掉
		sm.appendCompaction("摘要：正在写测试", keepFrom, 1234);
		const projected = sm.buildSessionProjection().messages;
		expect(projected.some((m) => m.role === "toolResult")).toBe(false);

		const backend = makeBackend(sm);
		expect(await backend.getTodos("s1")).toEqual([{ content: "写测试", status: "in_progress" }]);
	});

	it("没有 todo 工具结果 / 工具报错 → 空列表", async () => {
		const sm = SessionManager.inMemory();
		sm.appendMessage({ role: "user", content: "随便聊聊", timestamp: 1 } satisfies Message);
		const backend = makeBackend(sm);
		expect(await backend.getTodos("s1")).toEqual([]);

		const sm2 = SessionManager.inMemory();
		sm2.appendMessage({ ...todoResult([{ content: "x", status: "pending" }]), isError: true } as Message);
		expect(await makeBackend(sm2).getTodos("s1")).toEqual([]);
	});
});
