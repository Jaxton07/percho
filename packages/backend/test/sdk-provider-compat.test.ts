import { cleanupSessionResources, type Message, type Model, normalizeContext } from "@earendil-works/pi-ai";
import { stream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { afterEach, describe, expect, it } from "vitest";

const model: Model<"anthropic-messages"> = {
	id: "synthetic",
	name: "synthetic",
	provider: "anthropic",
	api: "anthropic-messages",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10000,
	maxTokens: 100,
};
const user = (content: string): Message => ({ role: "user", content, timestamp: 1 });
function response(id: string) {
	const events = [
		{
			type: "message_start",
			message: { id, model: "synthetic", usage: { input_tokens: 3, output_tokens: 0 } },
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "answer" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	];
	return new Response(
		events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
		{ headers: { "content-type": "text/event-stream" } },
	);
}
afterEach(() => cleanupSessionResources());
describe("Anthropic 请求兼容", () => {
	it("续跑仅发送增量，编辑历史或更换模型后发送完整上下文", async () => {
		const bodies: Record<string, any>[] = [];
		const fetcher: typeof fetch = async (_input, init) => {
			bodies.push(JSON.parse(String(init?.body)));
			return response(`reply-${bodies.length}`);
		};
		const run = async (messages: Message[], current = model) => {
			const result = await stream(current, normalizeContext({ systemPrompt: "system", messages }), {
				apiKey: "test",
				sessionId: "thread-test",
				fetch: fetcher,
			}).result();
			expect(result.stopReason).toBe("stop");
			return result;
		};
		const first = await run([user("one")]);
		const second = await run([user("one"), first, user("two")]);
		expect(bodies[0].thread).toEqual({ type: "create" });
		expect(bodies[1].thread).toEqual({ type: "continue", previous_message_id: "reply-1" });
		expect(bodies[1].messages).toHaveLength(1);
		await run([user("edited"), first, user("two"), second, user("three")]);
		expect(bodies[2].thread).toEqual({ type: "create" });
		expect(bodies[2].messages).toHaveLength(5);
		await run([user("one"), first, user("two")], { ...model, id: "different" });
		expect(bodies[3].thread).toEqual({ type: "create" });
	});
	it("线程过期时完整重建，端点不支持时回退并停用", async () => {
		const bodies: Record<string, any>[] = [];
		let failure = "";
		const fetcher: typeof fetch = async (_input, init) => {
			bodies.push(JSON.parse(String(init?.body)));
			if (failure) {
				const code = failure;
				failure = "";
				return new Response(
					JSON.stringify({
						type: "error",
						error: {
							type: "invalid_request_error",
							message: "thread rejected",
							details: { error_code: code },
						},
					}),
					{ status: 400, headers: { "content-type": "application/json" } },
				);
			}
			return response(`reply-${bodies.length}`);
		};
		const run = (messages: Message[]) =>
			stream(model, normalizeContext({ messages }), {
				apiKey: "test",
				sessionId: "fallback-test",
				fetch: fetcher,
				maxRetries: 0,
			}).result();
		const first = await run([user("one")]);
		failure = "thread_not_found";
		const second = await run([user("one"), first, user("two")]);
		expect(second.stopReason).toBe("stop");
		expect(bodies[1].thread.type).toBe("continue");
		expect(bodies[2].thread.type).toBe("create");
		expect(bodies[2].messages).toHaveLength(3);
		failure = "thread_unsupported_request";
		const third = await run([user("one"), first, user("two"), second, user("three")]);
		expect(third.stopReason).toBe("stop");
		expect(bodies[4].thread).toBeUndefined();
		await run([user("new conversation")]);
		expect(bodies[5].thread).toBeUndefined();
	});
	it("工具变化重建线程，随后各会话继续各自的线程", async () => {
		const bodies: Record<string, any>[] = [];
		const fetcher: typeof fetch = async (_input, init) => {
			bodies.push(JSON.parse(String(init?.body)));
			return response(`parallel-${bodies.length}`);
		};
		const run = (sessionId: string, messages: Message[], tools: any[] = []) =>
			stream(model, normalizeContext({ messages, tools }), {
				apiKey: "test",
				sessionId,
				fetch: fetcher,
			}).result();
		const [a, b] = await Promise.all([run("parallel-a", [user("a")]), run("parallel-b", [user("b")])]);
		await run(
			"parallel-a",
			[user("a"), a, user("a2")],
			[{ name: "search", description: "search", parameters: { type: "object", properties: {} } }],
		);
		await run("parallel-b", [user("b"), b, user("b2")]);
		expect(bodies[2].thread.type).toBe("create");
		expect(bodies[2].messages).toHaveLength(3);
		expect(bodies[3].thread).toEqual({ type: "continue", previous_message_id: "parallel-2" });
	});
	it("取消在途请求后安全重建完整上下文", async () => {
		const bodies: Record<string, any>[] = [];
		let entered!: () => void;
		const ready = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const controller = new AbortController();
		const fetcher: typeof fetch = async (_input, init) => {
			bodies.push(JSON.parse(String(init?.body)));
			if (bodies.length === 2) {
				entered();
				await new Promise<void>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
						once: true,
					});
				});
			}
			return response(`cancel-${bodies.length}`);
		};
		const run = (messages: Message[], signal?: AbortSignal) =>
			stream(model, normalizeContext({ messages }), {
				apiKey: "test",
				sessionId: "cancel-test",
				fetch: fetcher,
				signal,
				maxRetries: 0,
			}).result();
		const first = await run([user("one")]);
		const pending = run([user("one"), first, user("cancelled")], controller.signal);
		await ready;
		controller.abort();
		expect((await pending).stopReason).toBe("aborted");
		await run([user("one"), first, user("next")]);
		expect(bodies[2].thread).toEqual({ type: "create" });
		expect(bodies[2].messages).toHaveLength(3);
		expect(JSON.stringify(bodies[2].messages)).not.toContain("cancelled");
	});
	it("网关默认不发送 thread", async () => {
		let body: Record<string, unknown> = {};
		const result = await stream(
			{ ...model, baseUrl: "https://gateway.invalid" },
			normalizeContext({ messages: [user("hello")] }),
			{
				apiKey: "test",
				sessionId: "gateway-test",
				fetch: async (_input, init) => {
					body = JSON.parse(String(init?.body));
					return response("gateway");
				},
			},
		).result();
		expect(result.stopReason).toBe("stop");
		expect(body.thread).toBeUndefined();
	});
});
