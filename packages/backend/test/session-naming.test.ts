import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { autoNameSession } from "../src/session-naming";

function makeSession(existingName: string | null = null) {
	const calls: string[] = [];
	const session = {
		sessionManager: { getSessionName: () => existingName },
		setSessionName: (name: string) => {
			calls.push(name);
		},
	} as unknown as AgentSession;
	return { session, calls };
}

function userMsg(text: string): AgentSessionEvent {
	return {
		type: "message_start",
		message: { role: "user", content: [{ type: "text", text }] },
	} as unknown as AgentSessionEvent;
}

describe("autoNameSession", () => {
	it("第一条用户消息到达即命名（取首行）", () => {
		const { session, calls } = makeSession();
		autoNameSession(session, userMsg("帮我修复登录 bug\n具体看 auth.ts"));
		expect(calls).toEqual(["帮我修复登录 bug"]);
	});

	it("超过 30 字截断加省略号", () => {
		const { session, calls } = makeSession();
		autoNameSession(session, userMsg("这是一个非常非常长的标题它一定会超过三十个字符的限制所以应该被截断"));
		expect(calls).toHaveLength(1);
		expect(calls[0]).toHaveLength(31);
		expect(calls[0]?.endsWith("…")).toBe(true);
	});

	it("已有会话名时不再命名", () => {
		const { session, calls } = makeSession("已有标题");
		autoNameSession(session, userMsg("新消息"));
		expect(calls).toEqual([]);
	});

	it("agent_end 不再触发命名（标题在任务开始时已有）", () => {
		const { session, calls } = makeSession();
		autoNameSession(session, { type: "agent_end" } as unknown as AgentSessionEvent);
		expect(calls).toEqual([]);
	});

	it("非用户角色消息不命名", () => {
		const { session, calls } = makeSession();
		autoNameSession(session, {
			type: "message_start",
			message: { role: "assistant", content: [{ type: "text", text: "你好" }] },
		} as unknown as AgentSessionEvent);
		expect(calls).toEqual([]);
	});

	it("纯图片消息不命名，后续文本消息仍可命名", () => {
		const { session, calls } = makeSession();
		autoNameSession(session, {
			type: "message_start",
			message: { role: "user", content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] },
		} as unknown as AgentSessionEvent);
		expect(calls).toEqual([]);
		autoNameSession(session, userMsg("这张图里是什么"));
		expect(calls).toEqual(["这张图里是什么"]);
	});
});
