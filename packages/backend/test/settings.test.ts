import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

const files = new Map<string, string>();

vi.mock("node:fs/promises", () => ({
	readFile: vi.fn(async (path: string) => {
		const value = files.get(path);
		if (value === undefined) throw new Error("ENOENT");
		return value;
	}),
	writeFile: vi.fn(async (path: string, data: string) => {
		files.set(path, data);
	}),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
	getAgentDir: () => "/agent",
}));

import { SettingsService } from "../src/settings";

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

	it("replaces the key when provided, deletes it with clearApiKey", async () => {
		const { settings } = await seedProxy();

		await settings.updateCustomProvider({
			id: "proxy",
			baseUrl: "https://proxy.example/v1",
			api: "openai-completions",
			models: [{ id: "gpt-5" }],
			apiKey: "new-secret",
		});
		expect(JSON.parse(files.get("/agent/auth.json") ?? "{}").proxy.key).toBe("new-secret");

		await settings.updateCustomProvider({
			id: "proxy",
			baseUrl: "https://proxy.example/v1",
			api: "openai-completions",
			models: [{ id: "gpt-5" }],
			clearApiKey: true,
		});
		expect(JSON.parse(files.get("/agent/auth.json") ?? "{}").proxy).toBeUndefined();
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
