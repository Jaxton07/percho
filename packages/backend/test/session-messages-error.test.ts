import { messagesToUIMessages } from "@percho/shared";
import { describe, expect, it } from "vitest";
import { readSessionMessagesFromContent, toSessionMessages } from "../src/session/messages";

/**
 * 历史回放错误透传（error-system 阶段 2）：assistant 消息的 stopReason/errorMessage
 * 原样透传进 SessionMessage，纯错误轮（无正文/工具）不再被丢弃——否则历史回放产不出错误卡。
 */
const assistant = (id: string, stopReason: string, errorMessage?: string, text = "") => ({
	id,
	type: "message",
	message: {
		role: "assistant",
		stopReason,
		errorMessage,
		timestamp: 1000,
		content: text ? [{ type: "text", text }] : [],
	},
});
const omitted = (targetId: string, replacement: unknown = null) => ({
	type: "context_edit",
	targetId,
	replacement,
});
function history(...entries: Array<Record<string, unknown>>) {
	let parentId: string | null = null;
	const rows = entries.map((entry, index) => {
		const id = typeof entry.id === "string" ? entry.id : `entry-${index}`;
		const row = { ...entry, id, parentId, timestamp: "2026-01-01T00:00:00Z" };
		parentId = id;
		return row;
	});
	return readSessionMessagesFromContent(
		[
			{ type: "session", version: 3, id: "session", cwd: "/project", timestamp: "2026-01-01T00:00:00Z" },
			...rows,
		]
			.map((row) => JSON.stringify(row))
			.join("\n"),
	);
}
const errorCards = (messages: ReturnType<typeof history>) =>
	messagesToUIMessages(messages).filter((message) => message.kind === "error");

describe("持久化重试省略 — 历史失败卡", () => {
	it("省略的失败尝试恢复成功后不落卡，仍保留失败原文与 partial 正文", () => {
		const messages = history(
			assistant("attempt", "error", "503: temporary failure", "已生成的部分正文"),
			omitted("attempt"),
			assistant("recovered", "toolUse"),
			assistant("complete", "stop", undefined, "恢复后的正文"),
		);
		expect(errorCards(messages)).toHaveLength(0);
		expect(messages[0]).toMatchObject({
			role: "assistant",
			entryId: "attempt",
			stopReason: "error",
			errorMessage: "503: temporary failure",
			text: "已生成的部分正文",
			errorOmitted: true,
		});
		expect(
			messagesToUIMessages(messages)
				.filter((message) => message.kind === "assistant")
				.map((message) => message.text),
		).toEqual(["已生成的部分正文", "", "恢复后的正文"]);
	});
	it("只有省略而没有后续尝试或实时恢复事实时，保守保留最终失败", () => {
		const messages = history(assistant("attempt", "error", "context_length_exceeded"), omitted("attempt"));
		expect(errorCards(messages)).toHaveLength(1);
		expect(
			messagesToUIMessages(messages, { recovering: true }).filter((message) => message.kind === "error"),
		).toHaveLength(0);
	});
	it("用户新一轮消息不能冒充此前省略错误的恢复尝试", () => {
		const messages = history(
			assistant("attempt", "error", "503: failure"),
			omitted("attempt"),
			{ type: "message", message: { role: "user", content: "新的请求", timestamp: 2000 } },
			assistant("new-run", "stop", undefined, "新一轮回复"),
		);
		expect(errorCards(messages)).toHaveLength(1);
	});
	it("重试耗尽仅保留没有被省略的最后一次失败", () => {
		const messages = history(
			assistant("a", "error", "503: attempt 1"),
			omitted("a"),
			assistant("b", "error", "503: attempt 2"),
			omitted("b"),
			assistant("final", "error", "503: attempt 3"),
		);
		const cards = errorCards(messages);
		expect(cards).toHaveLength(1);
		expect(cards[0]).toMatchObject({
			error: { detail: "503: attempt 3", retryTarget: { entryId: "final", timestamp: 1000 } },
		});
	});
	it("最终失败后出现新的正常回复也不能仅凭相邻消息推断为自动恢复", () => {
		expect(
			errorCards(
				history(
					assistant("final", "error", "401: unauthorized"),
					assistant("later", "stop", undefined, "后续回复"),
				),
			),
		).toHaveLength(1);
	});
	it("消息载荷伪造的恢复标记不能替代真实分支上的省略条目", () => {
		const failure = assistant("final", "error", "503: exhausted");
		const messages = history(
			{
				...failure,
				message: { ...failure.message, sourceErrorOmitted: true, errorOmitted: true },
			},
			assistant("later", "stop", undefined, "后续回复"),
		);
		expect(errorCards(messages)).toHaveLength(1);
	});
	it("其他条目被省略不隐藏本次最终失败，也不删除正常历史正文", () => {
		const messages = history(
			assistant("old", "stop", undefined, "仍可查看的历史"),
			omitted("old"),
			assistant("final", "error", "503: exhausted"),
		);
		expect(errorCards(messages)).toHaveLength(1);
		expect(messagesToUIMessages(messages)[0]).toMatchObject({ text: "仍可查看的历史" });
	});
	it("后续非空上下文编辑撤销省略时，不继续采信旧的省略标记", () => {
		const messages = history(
			assistant("final", "error", "503: exhausted"),
			omitted("final"),
			omitted("final", { role: "assistant", content: [], stopReason: "stop", timestamp: 1000 }),
			assistant("later", "stop", undefined, "后续回复"),
		);
		expect(errorCards(messages)).toHaveLength(1);
	});
});

describe("toSessionMessages — 错误轮次透传", () => {
	it("纯错误轮（无正文/工具）保留为 assistant 消息 + 错误字段", () => {
		const out = toSessionMessages([
			{
				role: "assistant",
				content: "",
				stopReason: "error",
				errorMessage: '401: {"message":"Invalid API key provided"}',
				timestamp: 1000,
			},
		]);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			role: "assistant",
			text: "",
			thinking: "",
			tools: [],
			stopReason: "error",
			errorMessage: '401: {"message":"Invalid API key provided"}',
			timestamp: 1000,
		});
	});

	it("partial 正文 + 错误：正文保留 + 错误字段透传", () => {
		const out = toSessionMessages([
			{
				role: "assistant",
				content: [{ type: "text", text: "我正准备…" }],
				stopReason: "error",
				errorMessage: "429: rate limit",
				timestamp: 2000,
			},
		]);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			role: "assistant",
			text: "我正准备…",
			stopReason: "error",
			errorMessage: "429: rate limit",
		});
	});

	it("不带 stopReason 的旧消息（正常完成）不受影响，错误字段缺省", () => {
		const out = toSessionMessages([
			{
				role: "assistant",
				content: [{ type: "text", text: "你好" }],
				timestamp: 3000,
			},
		]);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ role: "assistant", text: "你好" });
		expect((out[0] as { stopReason?: string }).stopReason).toBeUndefined();
		expect((out[0] as { errorMessage?: string }).errorMessage).toBeUndefined();
	});

	it("stopReason 非 error（aborted 等）不透传错误字段", () => {
		const out = toSessionMessages([
			{
				role: "assistant",
				content: [{ type: "text", text: "被中止的部分" }],
				stopReason: "aborted",
				timestamp: 4000,
			},
		]);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ role: "assistant", text: "被中止的部分" });
		expect((out[0] as { errorMessage?: string }).errorMessage).toBeUndefined();
	});
});
