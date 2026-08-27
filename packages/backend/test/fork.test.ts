import type { Message } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { resolveForkEntryId } from "../src/session/messages";

/** 构造带 user→assistant→user 的内存会话，返回 manager 与 entry id（recall.test.ts 同风格） */
function makeSession() {
	const sm = SessionManager.inMemory();
	const question = sm.appendMessage({
		role: "user",
		content: "问题",
		timestamp: 1000,
	} satisfies Message);
	const reply = sm.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "回答" }],
		api: "anthropic",
		provider: "anthropic",
		model: "claude",
		timestamp: 1001,
	} as unknown as Message);
	const followUp = sm.appendMessage({ role: "user", content: "追问", timestamp: 2000 } satisfies Message);
	return { sm, question, reply, followUp };
}

describe("resolveForkEntryId（分叉目标解析）", () => {
	it("entryId 精确命中 assistant 消息", () => {
		const { sm, reply } = makeSession();
		expect(resolveForkEntryId(sm, { entryId: reply, text: "不同的文本不应影响精确定位" })).toBe(reply);
	});

	it("entryId 指向 user 消息时拒绝（B7：不静默接受非法分支点）", () => {
		const { sm, question } = makeSession();
		expect(() => resolveForkEntryId(sm, { entryId: question })).toThrow(/not an assistant message/);
	});

	it("entryId 不存在时回退 text 匹配（实时消息 entryId 缺失的兜底路径保留）", () => {
		const { sm, reply } = makeSession();
		expect(resolveForkEntryId(sm, { entryId: "nope", text: "回答" })).toBe(reply);
	});

	it("按文本从分支尾部匹配最近一条 assistant 消息", () => {
		const { sm, reply } = makeSession();
		expect(resolveForkEntryId(sm, { text: "回答" })).toBe(reply);
	});

	it("skill 展开消息（展示≠原文场景）以完整持久化正文走 text fallback", () => {
		const sm = SessionManager.inMemory();
		const rawText =
			'<skill name="mindmap" location="/tmp/skills/mindmap/SKILL.md">\nReferences are relative to /tmp/skills/mindmap.\n\nBody\n</skill>';
		const reply = sm.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: rawText }],
			api: "anthropic",
			provider: "anthropic",
			model: "claude",
			timestamp: 1001,
		} as unknown as Message);
		expect(resolveForkEntryId(sm, { text: rawText })).toBe(reply);
	});

	it("未命中（文本不存在 / 全空 ref）抛错", () => {
		const { sm } = makeSession();
		expect(() => resolveForkEntryId(sm, { text: "不存在" })).toThrow(/not found/);
		expect(() => resolveForkEntryId(sm, {})).toThrow(/not found/);
	});
});
