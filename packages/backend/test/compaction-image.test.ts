import { compact, generateSummaryWithUsage } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

/**
 * SDK 0.84 的 compaction 摘要请求不经过 Agent 的 context 钩子，
 * 但 generateSummaryWithUsage/generateTurnPrefixSummary 在 convertToLlm 之后
 * 还会 serializeConversation 成纯文本 prompt。这个测试把该行为钉住：
 * 文本模型 + 含图历史触发压缩时，摘要请求里不能出现 image block。
 */
const IMAGE = {
	type: "image" as const,
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lP3xWQAAAABJRU5ErkJggg==",
	mimeType: "image/png",
};

const TEXT_MODEL = {
	id: "text-only",
	name: "text-only",
	api: "openai-completions",
	provider: "test",
	baseUrl: "https://example.invalid/v1",
	reasoning: false,
	input: ["text"],
	cost: {},
	contextWindow: 128_000,
	maxTokens: 8_192,
};

const USAGE = {
	input: 10,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 12,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type CapturedRequest = { messages: { role: string; content: unknown }[] };

function makeStreamFn(calls: CapturedRequest[]) {
	return async (_model: unknown, context: CapturedRequest) => {
		calls.push(structuredClone(context));
		return {
			result: async () => ({
				stopReason: "success",
				content: [{ type: "text", text: "摘要" }],
				usage: USAGE,
			}),
		};
	};
}

function expectTextOnlyPrompt(request: CapturedRequest): void {
	expect(JSON.stringify(request).includes('"type":"image"')).toBe(false);
	for (const message of request.messages) {
		const types = Array.isArray(message.content)
			? message.content.map((block) => (block as { type?: unknown }).type)
			: [typeof message.content];
		expect(types).toEqual(["text"]);
	}
}

describe("compaction summary request image handling", () => {
	it("generateSummaryWithUsage 把含图历史序列化为纯文本请求", async () => {
		const calls: CapturedRequest[] = [];
		await generateSummaryWithUsage(
			[
				{
					role: "user",
					timestamp: 1,
					content: [{ type: "text", text: "请看这张图" }, IMAGE],
				},
				{ role: "assistant", timestamp: 2, content: [{ type: "text", text: "看到了" }] },
			],
			// 只验证请求形状，不需要真实 Model/StreamFn 完整类型。
			TEXT_MODEL as never,
			16_384,
			"test-key",
			{},
			new AbortController().signal,
			undefined,
			undefined,
			"off",
			makeStreamFn(calls) as never,
			{},
			{ enabled: false },
			undefined,
		);
		expect(calls).toHaveLength(1);
		expectTextOnlyPrompt(calls[0] as CapturedRequest);
	});

	it("split-turn compact 的历史摘要与 turn prefix 摘要都不带 image block", async () => {
		const calls: CapturedRequest[] = [];
		const streamFn = makeStreamFn(calls) as never;
		await compact(
			{
				firstKeptEntryId: "entry-kept",
				messagesToSummarize: [
					{
						role: "user",
						timestamp: 1,
						content: [{ type: "text", text: "历史图片" }, IMAGE],
					},
				],
				turnPrefixMessages: [
					{
						role: "user",
						timestamp: 2,
						content: [{ type: "text", text: "本 turn 前缀图片" }, IMAGE],
					},
				],
				isSplitTurn: true,
				tokensBefore: 10_000,
				previousSummary: undefined,
				fileOps: { read: new Set(), written: new Set(), edited: new Set() },
				settings: { reserveTokens: 16_384, keepRecentTokens: 20_000 },
			},
			TEXT_MODEL as never,
			"test-key",
			{},
			undefined,
			new AbortController().signal,
			"off",
			streamFn,
			{},
			{ enabled: false },
			undefined,
		);
		expect(calls).toHaveLength(2);
		for (const call of calls) expectTextOnlyPrompt(call);
	});
});
