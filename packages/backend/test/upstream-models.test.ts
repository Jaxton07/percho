import { describe, expect, it } from "vitest";
import {
	buildMetaIndex,
	enrichUpstreamModels,
	fetchUpstreamModels,
	metaLookupKeys,
	parseUpstreamModels,
} from "../src/settings/upstream-models";

describe("parseUpstreamModels", () => {
	it("兼容 data / models / 裸数组三种形状，并去重保序", () => {
		expect(parseUpstreamModels({ data: [{ id: "a" }, { id: "a" }, { id: "b", name: "B" }] })).toEqual([
			{ id: "a" },
			{ id: "b", name: "B" },
		]);
		expect(parseUpstreamModels({ models: ["x", "y"] })).toEqual([{ id: "x" }, { id: "y" }]);
	});

	it("忽略空 ID 与非模型条目", () => {
		expect(parseUpstreamModels({ data: [{ id: "  " }, { name: "no-id" }, 42, { id: "ok" }] })).toEqual([
			{ id: "ok" },
		]);
		expect(parseUpstreamModels("oops")).toEqual([]);
	});
});

describe("metaLookupKeys", () => {
	it("退化到去厂商前缀、去日期后缀的形式", () => {
		expect(metaLookupKeys("deepseek/deepseek-v4-1-flash")).toContain("deepseek-v4-1-flash");
		expect(metaLookupKeys("deepseek-v4-1-flash-261017")).toContain("deepseek-v4-1-flash");
		expect(metaLookupKeys("gpt-4o-20250617")).toContain("gpt-4o");
		expect(metaLookupKeys("  ")).toEqual([]);
	});
});

describe("enrichUpstreamModels", () => {
	it("用目录补上下文/输出/思考/图像，未知模型只回 ID", () => {
		const index = buildMetaIndex([
			{
				id: "deepseek/deepseek-chat",
				name: "DeepSeek Chat",
				reasoning: true,
				contextWindow: 128000,
				maxTokens: 8192,
			},
		]);
		const [known, unknown] = enrichUpstreamModels(
			[{ id: "deepseek-chat-250617" }, { id: "mystery-model" }],
			index,
		);
		expect(known).toEqual({
			id: "deepseek-chat-250617",
			name: "DeepSeek Chat",
			reasoning: true,
			contextWindow: 128000,
			maxTokens: 8192,
		});
		expect(unknown).toEqual({ id: "mystery-model" });
	});
});

describe("fetchUpstreamModels", () => {
	const json = (body: unknown, ok = true, status = 200) =>
		(async () => ({ ok, status, json: async () => body })) as unknown as typeof fetch;

	it("按协议分叉鉴权头，并解析响应", async () => {
		const seen: { url: string; headers: Record<string, string> }[] = [];
		const impl = (async (url: string, init: { headers: Record<string, string> }) => {
			seen.push({ url, headers: init.headers });
			return { ok: true, status: 200, json: async () => ({ data: [{ id: "m" }] }) };
		}) as unknown as typeof fetch;

		const models = await fetchUpstreamModels({
			baseUrl: "https://api.example.com/v1///",
			api: "openai-completions",
			apiKey: "sk-1",
			fetchImpl: impl,
		});
		expect(models).toEqual([{ id: "m" }]);
		expect(seen[0]?.url).toBe("https://api.example.com/v1/models");
		expect(seen[0]?.headers.Authorization).toBe("Bearer sk-1");

		await fetchUpstreamModels({
			baseUrl: "https://a.b/v1",
			api: "anthropic-messages",
			apiKey: "k",
			fetchImpl: impl,
		});
		expect(seen[1]?.headers["x-api-key"]).toBe("k");
		expect(seen[1]?.headers.Authorization).toBeUndefined();
	});

	it("非 2xx 抛错并带上状态码", async () => {
		await expect(
			fetchUpstreamModels({
				baseUrl: "https://x.y/v1",
				api: "openai-completions",
				apiKey: "k",
				fetchImpl: json({}, false, 401),
			}),
		).rejects.toThrow(/401/);
	});
});
