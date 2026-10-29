import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsService } from "../src/settings/settings";

let directory: string | undefined;
afterEach(async () => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	if (directory) await rm(directory, { recursive: true, force: true });
	directory = undefined;
});

async function setup(auth: object, configKey?: string, providerModels: object[] = [{ id: "fixture-model" }]) {
	const root = resolve(import.meta.dirname, "../../../.local/tmp/pr125-auth");
	await mkdir(root, { recursive: true });
	directory = await mkdtemp(join(root, "case-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", directory);
	const modelsPath = join(directory, "models.json");
	const authPath = join(directory, "auth.json");
	await writeFile(authPath, JSON.stringify(auth));
	await writeFile(
		modelsPath,
		JSON.stringify({
			providers: {
				proxy: {
					baseUrl: "https://example.invalid/v1",
					api: "openai-completions",
					models: providerModels,
					...(configKey ? { apiKey: configKey } : {}),
				},
			},
		}),
	);
	const runtime = await ModelRuntime.create({
		authPath,
		modelsPath,
		modelsStorePath: join(directory, "models-store.json"),
		refreshOnCreate: false,
	});
	const fetchMock = vi
		.fn()
		.mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "upstream-only-model" }] })));
	vi.stubGlobal("fetch", fetchMock);
	return { settings: new SettingsService(async () => runtime), fetchMock, runtime };
}

describe("自定义 provider 回填", () => {
	it("编辑表单能拿到落盘的思考档位映射，非法档位被丢弃", async () => {
		const thinkingLevelMap = { off: "none", minimal: null, high: " high ", bogus: "x" };
		const { settings } = await setup({}, undefined, [
			{ id: "fixture-model", reasoning: true, thinkingLevelMap },
		]);
		const provider = (await settings.listProviders()).find((entry) => entry.id === "proxy");
		expect(provider?.customModels).toEqual([
			{
				id: "fixture-model",
				reasoning: true,
				thinkingLevelMap: { off: "none", minimal: null, high: "high" },
			},
		]);
	});
});

describe("上游模型获取复用真实 SDK 凭证解析", () => {
	it("用户自定义模型不作为跨服务的能力来源，未知模型只返回 ID", async () => {
		const { settings, fetchMock } = await setup({});
		fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "fixture-model" }] })));
		const models = await settings.listUpstreamModels({
			baseUrl: "https://different.invalid/v1",
			api: "openai-completions",
			apiKey: "fixture-explicit",
		});
		expect(models.models).toEqual([{ id: "fixture-model" }]);
		expect(models.baseUrl).toBe("https://different.invalid/v1");
	});

	it("内置模型的能力不受运行时同名模型覆写影响", async () => {
		const { settings, fetchMock, runtime } = await setup({});
		const builtin = getBuiltinModel("openai", "gpt-4o");
		vi.spyOn(runtime, "getModels").mockReturnValue([{ ...builtin, contextWindow: 17000, maxTokens: 1234 }]);
		fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "gpt-4o" }] })));
		const [model] = (
			await settings.listUpstreamModels({
				baseUrl: "https://different.invalid/v1",
				api: "openai-completions",
				apiKey: "fixture-explicit",
			})
		).models;
		expect(model).toMatchObject({
			id: "gpt-4o",
			contextWindow: builtin.contextWindow,
			maxTokens: builtin.maxTokens,
		});
	});

	it.each(["auth", "models"])("解析 %s 配置中的环境变量，密钥不回传给界面", async (source) => {
		vi.stubEnv("PERCHO_UPSTREAM_TEST_KEY", "fixture-env-value");
		const reference = "$PERCHO_UPSTREAM_TEST_KEY";
		const { settings, fetchMock } = await setup(
			source === "auth" ? { proxy: { type: "api_key", key: reference } } : {},
			source === "models" ? reference : undefined,
		);
		const models = await settings.listUpstreamModels({ providerId: "proxy", baseUrl: "", api: "" });
		expect(fetchMock).toHaveBeenCalledWith(
			"https://example.invalid/v1/models",
			expect.objectContaining({ headers: { Authorization: "Bearer fixture-env-value" } }),
		);
		expect(models.models).toEqual([{ id: "upstream-only-model" }]);
	});

	it("执行已保存的密钥命令，发送其输出", async () => {
		const { settings, fetchMock } = await setup({
			proxy: { type: "api_key", key: "!echo fixture-command-value" },
		});
		await settings.listUpstreamModels({ providerId: "proxy", baseUrl: "", api: "" });
		expect(fetchMock).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ headers: { Authorization: "Bearer fixture-command-value" } }),
		);
	});

	it("临时输入的密钥优先，不触发保存的无效引用", async () => {
		const { settings, fetchMock } = await setup({
			proxy: { type: "api_key", key: "$PERCHO_UPSTREAM_MISSING_KEY" },
		});
		await settings.listUpstreamModels({
			providerId: "proxy",
			baseUrl: "",
			api: "",
			apiKey: "fixture-explicit",
		});
		expect(fetchMock).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ headers: { Authorization: "Bearer fixture-explicit" } }),
		);
	});

	it("无凭证时不发上游请求", async () => {
		const { settings, fetchMock } = await setup({});
		await expect(settings.listUpstreamModels({ providerId: "proxy", baseUrl: "", api: "" })).rejects.toThrow(
			/API Key/,
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
