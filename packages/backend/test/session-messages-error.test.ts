import { describe, expect, it } from "vitest";
import { toSessionMessages } from "../src/session/messages";

/**
 * 历史回放错误透传（error-system 阶段 2）：assistant 消息的 stopReason/errorMessage
 * 原样透传进 SessionMessage，纯错误轮（无正文/工具）不再被丢弃——否则历史回放产不出错误卡。
 */
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
