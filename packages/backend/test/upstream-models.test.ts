import { describe, expect, it } from "vitest";
import {
	buildMetaIndex,
	enrichUpstreamModels,
	fetchUpstreamModels,
	looksLikeModelList,
	metaLookupKeys,
	needsApiVersionProbe,
	parseUpstreamModels,
	resolveUpstreamBaseUrl,
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
	it.each(["vendor/model", "model-250617", "vendor/model-20250617"])(
		"精确 ID 优先于先入索引的别名 %s，且不依赖目录顺序",
		(alias) => {
			const approximate = { id: alias, contextWindow: 32000, maxTokens: 4096 };
			const exact = { id: "model", contextWindow: 128000, maxTokens: 16384, imageInput: true };
			for (const models of [
				[approximate, exact],
				[exact, approximate],
			]) {
				expect(enrichUpstreamModels([{ id: "model" }], buildMetaIndex(models))).toEqual([exact]);
				expect(enrichUpstreamModels([{ id: alias }], buildMetaIndex(models))).toEqual([approximate]);
			}
		},
	);

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

	it("从目录带出思考档位映射（/models 本身没有），空映射不写", () => {
		const thinkingLevelMap = { minimal: "minimal", low: "low", medium: null, high: "high", xhigh: "xhigh" };
		const index = buildMetaIndex([
			{ id: "vendor/with-map", reasoning: true, thinkingLevelMap },
			{ id: "vendor/empty-map", reasoning: true, thinkingLevelMap: {} },
		]);
		expect(enrichUpstreamModels([{ id: "with-map" }], index)).toEqual([
			{ id: "with-map", reasoning: true, thinkingLevelMap },
		]);
		expect(enrichUpstreamModels([{ id: "empty-map" }], index)).toEqual([
			{ id: "empty-map", reasoning: true },
		]);
	});
});

describe("buildMetaIndex 厂商优先级", () => {
	it("同一 ID 多 provider 时优先厂商官方条目，避免继承代理特有档位", () => {
		const azure = {
			id: "gpt-x",
			provider: "azure",
			api: "azure-openai-responses",
			thinkingLevelMap: { off: null, xhigh: "xhigh" },
		};
		const openai = {
			id: "gpt-x",
			provider: "openai",
			api: "openai-responses",
			thinkingLevelMap: { off: "none", high: "high" },
		};
		// 与目录顺序无关
		for (const models of [
			[azure, openai],
			[openai, azure],
		]) {
			const index = buildMetaIndex(models, { provider: "openai", api: "openai-completions" });
			expect(index.get("gpt-x")?.thinkingLevelMap).toEqual({ off: "none", high: "high" });
		}
	});

	it("没有厂商官方条目时，同协议条目优先于其他代理", () => {
		const azure = {
			id: "gpt-y",
			provider: "azure",
			api: "azure-openai-responses",
			thinkingLevelMap: { off: null },
		};
		const copilot = {
			id: "gpt-y",
			provider: "github-copilot",
			api: "openai-responses",
			thinkingLevelMap: { minimal: "low" },
		};
		const index = buildMetaIndex([azure, copilot], { provider: "openai", api: "openai-responses" });
		expect(index.get("gpt-y")?.thinkingLevelMap).toEqual({ minimal: "low" });
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

		const result = await fetchUpstreamModels({
			baseUrl: "https://api.example.com/v1///",
			api: "openai-completions",
			apiKey: "sk-1",
			fetchImpl: impl,
		});
		expect(result.models).toEqual([{ id: "m" }]);
		expect(result.baseUrl).toBe("https://api.example.com/v1");
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

	it("站点根回 HTML 首页时自动试 /v1（New API 类中转站）", async () => {
		const seen: string[] = [];
		const impl = (async (url: string) => {
			seen.push(url);
			if (url === "https://relay.example.com/models") {
				// 未知路径回 200 + 前端 HTML：JSON.parse 失败，不能被当成可用端点
				return { ok: true, status: 200, json: async () => JSON.parse("<!doctype html>") };
			}
			return { ok: true, status: 200, json: async () => ({ data: [{ id: "gpt-x" }] }) };
		}) as unknown as typeof fetch;

		const result = await fetchUpstreamModels({
			baseUrl: "https://relay.example.com",
			api: "openai-completions",
			apiKey: "k",
			fetchImpl: impl,
		});
		expect(seen).toEqual(["https://relay.example.com/models", "https://relay.example.com/v1/models"]);
		expect(result).toEqual({ models: [{ id: "gpt-x" }], baseUrl: "https://relay.example.com/v1" });
	});

	it("裸站点根两个候选都失败时，错误信息说清 /v1 的可能", async () => {
		const impl = (async () => ({
			ok: true,
			status: 200,
			json: async () => JSON.parse("<!doctype html>"),
		})) as unknown as typeof fetch;
		await expect(
			fetchUpstreamModels({
				baseUrl: "https://relay.example.com",
				api: "openai-completions",
				apiKey: "k",
				fetchImpl: impl,
			}),
		).rejects.toThrow(/\/v1/);
	});
});

describe("needsApiVersionProbe", () => {
	it("只有 OpenAI 兼容协议 + 裸站点根才探测", () => {
		expect(needsApiVersionProbe("https://relay.example.com", "openai-completions")).toBe(true);
		expect(needsApiVersionProbe("https://relay.example.com/", "openai-responses")).toBe(true);
		// 已带路径：/v1、/v1beta/openai、azure 的 /openai 都尊重用户输入
		for (const url of [
			"https://relay.example.com/v1",
			"https://relay.example.com/v1/",
			"https://relay.example.com/v1beta/openai",
			"https://x.openai.azure.com/openai",
		]) {
			expect(needsApiVersionProbe(url, "openai-completions")).toBe(false);
		}
		// 非 OpenAI 协议（anthropic 的基址本来就不带 /v1）一律不动
		expect(needsApiVersionProbe("https://api.anthropic.com", "anthropic-messages")).toBe(false);
		expect(needsApiVersionProbe("not-a-url", "openai-completions")).toBe(false);
	});
});

describe("looksLikeModelList", () => {
	it("只认数组与 data/models 数组，HTML 解析出的字符串不算", () => {
		expect(looksLikeModelList([])).toBe(true);
		expect(looksLikeModelList({ data: [] })).toBe(true);
		expect(looksLikeModelList({ models: ["a"] })).toBe(true);
		expect(looksLikeModelList("<!doctype html>")).toBe(false);
		expect(looksLikeModelList({ error: "not found" })).toBe(false);
		expect(looksLikeModelList(null)).toBe(false);
	});
});

describe("resolveUpstreamBaseUrl", () => {
	const relay = (failPaths: string[]) => {
		const calls: string[] = [];
		const impl = (async (url: string) => {
			calls.push(url);
			if (failPaths.some((path) => url === `https://relay.example.com${path}`)) {
				return { ok: true, status: 200, json: async () => JSON.parse("<!doctype html>") };
			}
			return { ok: true, status: 200, json: async () => ({ data: [{ id: "m" }] }) };
		}) as unknown as typeof fetch;
		return { impl, calls };
	};

	it("根地址能返回清单就保持原样", async () => {
		const { impl } = relay([]);
		await expect(
			resolveUpstreamBaseUrl({
				baseUrl: "https://relay.example.com/",
				api: "openai-completions",
				apiKey: "k",
				fetchImpl: impl,
			}),
		).resolves.toEqual({ baseUrl: "https://relay.example.com", normalized: false });
	});

	it("根地址只回 HTML、/v1 可用时补成 /v1", async () => {
		const { impl, calls } = relay(["/models"]);
		await expect(
			resolveUpstreamBaseUrl({
				baseUrl: "https://relay.example.com",
				api: "openai-completions",
				apiKey: "k",
				fetchImpl: impl,
			}),
		).resolves.toEqual({ baseUrl: "https://relay.example.com/v1", normalized: true });
		// 两个候选并发探测
		expect(calls).toHaveLength(2);
	});

	it("都失败（离线/密钥错）就原样返回，不阻断保存", async () => {
		const { impl } = relay(["/models", "/v1/models"]);
		await expect(
			resolveUpstreamBaseUrl({
				baseUrl: "https://relay.example.com",
				api: "openai-completions",
				apiKey: "k",
				fetchImpl: impl,
			}),
		).resolves.toEqual({ baseUrl: "https://relay.example.com", normalized: false });
	});

	it("已带路径或非 OpenAI 协议不发任何请求", async () => {
		const calls: string[] = [];
		const impl = (async (url: string) => {
			calls.push(url);
			return { ok: true, status: 200, json: async () => ({ data: [] }) };
		}) as unknown as typeof fetch;
		await expect(
			resolveUpstreamBaseUrl({
				baseUrl: "https://relay.example.com/v1",
				api: "openai-completions",
				apiKey: "k",
				fetchImpl: impl,
			}),
		).resolves.toEqual({ baseUrl: "https://relay.example.com/v1", normalized: false });
		await resolveUpstreamBaseUrl({
			baseUrl: "https://api.anthropic.com",
			api: "anthropic-messages",
			apiKey: "k",
			fetchImpl: impl,
		});
		expect(calls).toEqual([]);
	});
});
