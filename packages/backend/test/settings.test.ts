import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

const files = new Map<string, string>();

vi.mock("node:fs/promises", () => ({
	readFile: vi.fn(async (path: string) => {
		const value = files.get(path);
		if (value === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
		return value;
	}),
	writeFile: vi.fn(async (path: string, data: string) => {
		files.set(path, data);
	}),
	// JsonStore 同目录 tmp+rename 原子写所需的配套原语（内存 Map 模拟）
	mkdir: vi.fn(async () => {}),
	rename: vi.fn(async (from: string, to: string) => {
		const value = files.get(from);
		if (value === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
		files.set(to, value);
		files.delete(from);
	}),
	rm: vi.fn(async () => {}),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
	getAgentDir: () => "/agent",
}));

import { SettingsService } from "../src/settings/settings";

describe("SettingsService provider mutations", () => {
	beforeEach(() => files.clear());

	it("adds a custom provider without starting an unbounded network refresh", async () => {
		const refresh = vi.fn().mockResolvedValue({ aborted: false });
		const settings = new SettingsService(async () => ({ refresh }) as unknown as ModelRuntime);

		await settings.addCustomProvider({
			id: "proxy",
			baseUrl: "https://proxy.example/v1",
			api: "openai-codex-responses",
			models: [{ id: "gpt-5" }],
			apiKey: "secret",
		});

		expect(refresh).toHaveBeenCalledOnce();
		expect(refresh).toHaveBeenCalledWith({ allowNetwork: false });
		expect(JSON.parse(files.get("/agent/models.json") ?? "{}").providers.proxy).toMatchObject({
			baseUrl: "https://proxy.example/v1",
			api: "openai-codex-responses",
		});
	});

	function makeSettings() {
		const refresh = vi.fn().mockResolvedValue({ aborted: false });
		const settings = new SettingsService(async () => ({ refresh }) as unknown as ModelRuntime);
		return { settings, refresh };
	}

	async function seedProxy() {
		const { settings, refresh } = makeSettings();
		await settings.addCustomProvider({
			id: "proxy",
			name: "Proxy",
			baseUrl: "https://proxy.example/v1",
			api: "openai-completions",
			models: [{ id: "gpt-5" }],
			apiKey: "secret",
		});
		return { settings, refresh };
	}

	it("updates fields of an existing custom provider, keeping the stored key when blank", async () => {
		const { settings, refresh } = await seedProxy();
		refresh.mockClear();

		await settings.updateCustomProvider({
			id: "proxy",
			name: "Proxy 2",
			baseUrl: "https://proxy2.example/v1",
			api: "openai-responses",
			models: [{ id: "gpt-5" }, { id: "gpt-5-mini" }],
		});

		expect(JSON.parse(files.get("/agent/models.json") ?? "{}").providers.proxy).toMatchObject({
			name: "Proxy 2",
			baseUrl: "https://proxy2.example/v1",
			api: "openai-responses",
			models: [{ id: "gpt-5" }, { id: "gpt-5-mini" }],
		});
		// key 留空 = auth.json 原样保留
		expect(JSON.parse(files.get("/agent/auth.json") ?? "{}").proxy).toEqual({
			type: "api_key",
			key: "secret",
		});
		expect(refresh).toHaveBeenCalledWith({ allowNetwork: false });
	});

	it("clears the display name when emptied on update", async () => {
		const { settings } = await seedProxy();
		await settings.updateCustomProvider({
			id: "proxy",
			baseUrl: "https://proxy.example/v1",
			api: "openai-completions",
			models: [{ id: "gpt-5" }],
		});
		const entry = JSON.parse(files.get("/agent/models.json") ?? "{}").providers.proxy;
		expect(entry).not.toHaveProperty("name");
	});

	it("replaces the key when provided; key untouched when omitted", async () => {
		const { settings } = await seedProxy();

		await settings.updateCustomProvider({
			id: "proxy",
			baseUrl: "https://proxy.example/v1",
			api: "openai-completions",
			models: [{ id: "gpt-5" }],
			apiKey: "new-secret",
		});
		expect(JSON.parse(files.get("/agent/auth.json") ?? "{}").proxy.key).toBe("new-secret");

		// 不传 key = 保持不变（删除凭证走 removeCredential/removeCustomProvider）
		await settings.updateCustomProvider({
			id: "proxy",
			baseUrl: "https://proxy.example/v1",
			api: "openai-completions",
			models: [{ id: "gpt-5" }],
		});
		expect(JSON.parse(files.get("/agent/auth.json") ?? "{}").proxy.key).toBe("new-secret");
	});

	it("writes per-model metadata (reasoning/contextWindow/maxTokens/input) when provided", async () => {
		const { settings } = makeSettings();
		await settings.addCustomProvider({
			id: "relay",
			baseUrl: "https://www.aicodemirror.ai/v1",
			api: "openai-completions",
			models: [
				{ id: "gpt-5.6-terra", reasoning: true, contextWindow: 256000, maxTokens: 64000, imageInput: true },
				{ id: "gpt-5-mini" },
			],
		});
		const providers = JSON.parse(files.get("/agent/models.json") ?? "{}").providers;
		expect(providers.relay.models[0]).toEqual({
			id: "gpt-5.6-terra",
			reasoning: true,
			contextWindow: 256000,
			maxTokens: 64000,
			input: ["text", "image"],
		});
		// 未设置的字段不落盘，跟随 SDK 默认
		expect(providers.relay.models[1]).toEqual({ id: "gpt-5-mini" });
	});

	it("rejects non-positive contextWindow/maxTokens", async () => {
		const { settings } = makeSettings();
		await expect(
			settings.addCustomProvider({
				id: "relay",
				baseUrl: "https://x.example",
				api: "openai-completions",
				models: [{ id: "m", contextWindow: 0 }],
			}),
		).rejects.toThrow("contextWindow");
	});

	it("rejects update for unknown or invalid input", async () => {
		const { settings } = await seedProxy();
		await expect(
			settings.updateCustomProvider({
				id: "ghost",
				baseUrl: "https://x.example",
				api: "openai-completions",
				models: [{ id: "m" }],
			}),
		).rejects.toThrow("不存在");
		await expect(
			settings.updateCustomProvider({
				id: "proxy",
				baseUrl: "",
				api: "openai-completions",
				models: [{ id: "m" }],
			}),
		).rejects.toThrow("baseUrl");
	});
});

describe("内置 provider 改名读侧归一（azure-openai-responses → azure，pi 1.0.4）", () => {
	function fakeRuntime(providerIds: string[]) {
		return {
			refresh: vi.fn().mockResolvedValue({ aborted: false }),
			getProviders: () => providerIds.map((id) => ({ id, name: id, auth: {} })),
			getProviderAuthStatus: () => ({ configured: true, source: "api_key", label: "API key" }),
			getModels: () => [{ id: "gpt-5", name: "GPT-5" }],
		} as unknown as ModelRuntime;
	}

	function modelJson(providers: Record<string, unknown>) {
		files.set("/agent/models.json", JSON.stringify({ providers }));
	}

	beforeEach(() => files.clear());

	it("models.json 里旧 id 的覆写条目仍判为「覆写内置」并回填表单", async () => {
		// 官方 1.0.4 把该内置 provider 改名 azure；用户盘上还是旧键，不归一就会退化成孤儿自定义 provider
		modelJson({ "azure-openai-responses": { baseUrl: "https://my.example/v1" } });
		const settings = new SettingsService(async () => fakeRuntime(["azure"]));

		const azure = (await settings.listProviders()).find((p) => p.id === "azure");

		expect(azure).toMatchObject({
			custom: true,
			overridesBuiltin: true,
			baseUrl: "https://my.example/v1",
		});
	});

	it("新 id 已存在时优先用新 id 的条目（旧键只作兜底）", async () => {
		modelJson({
			azure: { baseUrl: "https://new.example/v1" },
			"azure-openai-responses": { baseUrl: "https://old.example/v1" },
		});
		const settings = new SettingsService(async () => fakeRuntime(["azure"]));

		const azure = (await settings.listProviders()).find((p) => p.id === "azure");
		expect(azure?.baseUrl).toBe("https://new.example/v1");
	});

	it("旧 id 作为新增输入被拒（提示新 id，避免造出孤儿重复 provider）", async () => {
		const settings = new SettingsService(async () => fakeRuntime([]));

		await expect(
			settings.addCustomProvider({
				id: "azure-openai-responses",
				baseUrl: "https://x.example/v1",
				api: "openai-responses",
				models: [{ id: "gpt-5" }],
			}),
		).rejects.toThrow(/已改名为 azure/);
	});

	it("编辑基址（新 id）把旧键条目并过来，不留孤儿", async () => {
		modelJson({ "azure-openai-responses": { baseUrl: "https://old.example/v1", headers: { a: "b" } } });
		const settings = new SettingsService(async () => fakeRuntime(["azure"]));

		await settings.setProviderBaseUrl("azure", "https://new.example/v1");

		expect(JSON.parse(files.get("/agent/models.json") ?? "{}").providers).toEqual({
			azure: { headers: { a: "b" }, baseUrl: "https://new.example/v1" },
		});
	});

	it("删除 provider 连旧键一起清掉", async () => {
		modelJson({ "azure-openai-responses": { baseUrl: "https://old.example/v1" } });
		files.set("/agent/auth.json", JSON.stringify({}));
		const settings = new SettingsService(async () => fakeRuntime(["azure"]));

		await settings.removeCustomProvider("azure");

		expect(JSON.parse(files.get("/agent/models.json") ?? "{}").providers).toEqual({});
	});
});
