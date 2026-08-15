import type { Message } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { resolveRecallEntryId } from "../src/pi-backend";

/** 构造带两条用户消息（+一条回复在中间）的内存会话，返回 manager 与 entry id */
function makeSession() {
	const sm = SessionManager.inMemory();
	const first = sm.appendMessage({ role: "user", content: "第一条", timestamp: 1000 } satisfies Message);
	const reply = sm.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "回复" }],
		api: "anthropic",
		provider: "anthropic",
		model: "claude",
		timestamp: 1001,
	} as unknown as Message);
	const second = sm.appendMessage({ role: "user", content: "第二条", timestamp: 2000 } satisfies Message);
	return { sm, first, reply, second };
}

describe("resolveRecallEntryId（撤回目标解析）", () => {
	it("entryId 精确命中用户消息", () => {
		const { sm, second } = makeSession();
		expect(resolveRecallEntryId(sm, { entryId: second })).toBe(second);
	});

	it("entryId 指向非用户消息时拒绝", () => {
		const { sm, reply } = makeSession();
		expect(() => resolveRecallEntryId(sm, { entryId: reply })).toThrow(/not a user message/);
	});

	it("entryId 不存在时抛错", () => {
		const { sm } = makeSession();
		expect(() => resolveRecallEntryId(sm, { entryId: "nope" })).toThrow(/not found/);
	});

	it("按文本从分支尾部匹配最近一条同文用户消息", () => {
		const { sm, second } = makeSession();
		expect(resolveRecallEntryId(sm, { text: "第二条" })).toBe(second);
	});

	it("text + timestamp 双锚定：时间戳不符时不命中", () => {
		const { sm } = makeSession();
		expect(() => resolveRecallEntryId(sm, { text: "第二条", timestamp: 9999 })).toThrow(/not found/);
		expect(resolveRecallEntryId(sm, { text: "第二条", timestamp: 2000 })).toBeDefined();
	});

	it("未命中（文本不存在 / 全空 ref）抛错", () => {
		const { sm } = makeSession();
		expect(() => resolveRecallEntryId(sm, { text: "不存在" })).toThrow(/not found/);
		expect(() => resolveRecallEntryId(sm, {})).toThrow(/not found/);
	});

	it("只匹配当前 leaf 路径：branch 回退后侧枝上的消息不可见", () => {
		const { sm, first } = makeSession();
		sm.branch(first);
		expect(() => resolveRecallEntryId(sm, { text: "第二条" })).toThrow(/not found/);
		expect(resolveRecallEntryId(sm, { text: "第一条" })).toBe(first);
	});
});

describe("撤回持久化机制（SessionManager 层语义）", () => {
	it("branch + custom entry 标记后，上下文排除被撤回消息且 leaf 落在标记上", () => {
		const sm = SessionManager.inMemory();
		const first = sm.appendMessage({ role: "user", content: "a", timestamp: 1 } satisfies Message);
		const second = sm.appendMessage({ role: "user", content: "b", timestamp: 2 } satisfies Message);
		// 撤回第二条：leaf 回到 first，追加不进上下文的 custom 标记（重启后按文件序 leaf=标记）
		sm.branch(first);
		sm.appendCustomEntry("message-recalled", { recalledEntryId: second });
		const context = sm.buildSessionContext();
		expect(context.messages).toHaveLength(1);
		expect(context.messages[0]).toMatchObject({ role: "user" });
		const leaf = sm.getLeafEntry();
		expect(leaf?.type).toBe("custom");
	});
});
