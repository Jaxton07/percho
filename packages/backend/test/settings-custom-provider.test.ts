import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { SettingsService } from "../src/settings/settings";

/** 构造假 runtime：getProvider 用于「空模型列表」校验（内置 id 存在 / 全新 id 不存在） */
function fakeRuntime(existing: string[]): ModelRuntime {
	return {
		getProvider: (id: string) => (existing.includes(id) ? { id } : undefined),
		refresh: async () => ({ aborted: false, errors: new Map() }),
	} as unknown as ModelRuntime;
}

function makeService(existing: string[]): SettingsService {
	return new SettingsService(async () => fakeRuntime(existing));
}

describe("SettingsService 自定义 provider — 空模型列表语义", () => {
	it("覆写内置 provider（openai）允许模型留空，且不写 models 键", () => {
		const svc = makeService(["openai"]);
		// 写文件前先备份/不影响真实目录：直接检查 buildCustomEntry 产物
		const entry = (
			svc as unknown as { buildCustomEntry(input: unknown): Record<string, unknown> }
		).buildCustomEntry({
			id: "openai",
			baseUrl: "https://proxy.example.com/v1",
			api: "openai-responses",
			models: [],
		});
		expect(entry.baseUrl).toBe("https://proxy.example.com/v1");
		expect(entry.models).toBeUndefined();
	});

	it("全新 provider 留空模型被拒绝（提示先加模型或用内置 ID）", () => {
		const svc = makeService([]);
		expect(() =>
			(
				svc as unknown as { assertModelsMeaningful(id: string, models: unknown[]): void }
			).assertModelsMeaningful("my-proxy", []),
		).toThrow(/不是内置 provider/);
	});

	it("【回归】runtime 已注册的自定义 provider（非内置 id）清空模型仍被拒", () => {
		// models.json 里的自定义 provider 也会注册进 runtime（providerIds 含 config ids），
		// 若用 runtime.getProvider 判定会漏拦，落盘零模型死 provider
		const svc = makeService(["my-proxy"]);
		expect(() =>
			(
				svc as unknown as { assertModelsMeaningful(id: string, models: unknown[]): void }
			).assertModelsMeaningful("my-proxy", []),
		).toThrow(/不是内置 provider/);
	});

	it("覆写内置 provider 校验通过", () => {
		const svc = makeService([]);
		expect(
			(
				svc as unknown as { assertModelsMeaningful(id: string, models: unknown[]): void }
			).assertModelsMeaningful("anthropic", []),
		).toBeUndefined();
	});

	it("有模型时不做存在性校验", () => {
		const svc = makeService([]);
		expect(
			(
				svc as unknown as { assertModelsMeaningful(id: string, models: unknown[]): void }
			).assertModelsMeaningful("my-proxy", [{ id: "m1" }]),
		).toBeUndefined();
	});

	it("非法 baseUrl 被拒（与 setProviderBaseUrl 口径一致）", () => {
		const svc = makeService([]);
		expect(() =>
			(svc as unknown as { buildCustomEntry(input: unknown): Record<string, unknown> }).buildCustomEntry({
				id: "my-proxy",
				baseUrl: "not-a-url",
				api: "openai-completions",
				models: [{ id: "m1" }],
			}),
		).toThrow(/http/);
	});
});

describe("SettingsService.updateCustomProvider — 不丢 pi 手写字段", () => {
	function withTmpAgentDir(body: (svc: SettingsService, dir: string) => Promise<void>) {
		return async () => {
			const dir = mkdtempSync(join(tmpdir(), "percho-settings-"));
			const prev = process.env.PI_CODING_AGENT_DIR;
			process.env.PI_CODING_AGENT_DIR = dir;
			const svc = makeService(["openai"]);
			try {
				await body(svc, dir);
			} finally {
				process.env.PI_CODING_AGENT_DIR = prev;
			}
		};
	}

	it(
		"编辑保存保留 models.json 里的 apiKey/headers 等表单不管理字段",
		withTmpAgentDir(async (svc, dir) => {
			writeFileSync(
				join(dir, "models.json"),
				JSON.stringify({
					providers: {
						openai: {
							baseUrl: "https://old.example.com/v1",
							api: "openai-responses",
							apiKey: "sk-pi-tui-written",
							headers: { "x-custom": "1" },
							modelOverrides: { "gpt-4.1": { contextWindow: 1048576 } },
						},
					},
				}),
			);
			await svc.updateCustomProvider({
				id: "openai",
				baseUrl: "https://new.example.com/v1",
				api: "openai-responses",
				models: [{ id: "gpt-4" }],
			});
			const saved = JSON.parse(readFileSync(join(dir, "models.json"), "utf-8"));
			const entry = saved.providers.openai;
			expect(entry.baseUrl).toBe("https://new.example.com/v1");
			expect(entry.apiKey).toBe("sk-pi-tui-written");
			expect(entry.headers).toEqual({ "x-custom": "1" });
			expect(entry.modelOverrides).toEqual({ "gpt-4.1": { contextWindow: 1048576 } });
			expect(entry.models).toEqual([{ id: "gpt-4" }]);
			expect(entry.name).toBeUndefined(); // 表单 name 清空 = 删字段回落 id
		}),
	);
});

describe("SettingsService.setProviderBaseUrl — 内置 provider 端点覆写", () => {
	function withTmpAgentDir(body: (svc: SettingsService, dir: string) => Promise<void>) {
		return async () => {
			const dir = mkdtempSync(join(tmpdir(), "percho-baseurl-"));
			const prev = process.env.PI_CODING_AGENT_DIR;
			process.env.PI_CODING_AGENT_DIR = dir;
			const svc = makeService(["openai"]);
			try {
				await body(svc, dir);
			} finally {
				process.env.PI_CODING_AGENT_DIR = prev;
			}
		};
	}

	it(
		"无条目时创建纯 baseUrl 覆写，不写 models/api",
		withTmpAgentDir(async (svc, dir) => {
			await svc.setProviderBaseUrl("openai", "https://sub.h4rvey.com/v1", "sk-123");
			const saved = JSON.parse(readFileSync(join(dir, "models.json"), "utf-8"));
			expect(saved.providers.openai).toEqual({ baseUrl: "https://sub.h4rvey.com/v1" });
			const auth = JSON.parse(readFileSync(join(dir, "auth.json"), "utf-8"));
			expect(auth.openai).toEqual({ type: "api_key", key: "sk-123" });
		}),
	);

	it(
		"已有条目只更新 baseUrl，保留 pi 手写字段",
		withTmpAgentDir(async (svc, dir) => {
			writeFileSync(
				join(dir, "models.json"),
				JSON.stringify({
					providers: {
						openai: { baseUrl: "https://old.example.com/v1", apiKey: "sk-pi", headers: { "x-a": "1" } },
					},
				}),
			);
			await svc.setProviderBaseUrl("openai", "https://new.example.com/v1");
			const saved = JSON.parse(readFileSync(join(dir, "models.json"), "utf-8"));
			expect(saved.providers.openai).toEqual({
				baseUrl: "https://new.example.com/v1",
				apiKey: "sk-pi",
				headers: { "x-a": "1" },
			});
		}),
	);

	it(
		"baseUrl 空 = 删除条目回官方（不动 auth.json 凭证——删除凭证走行上的「移除凭证」）",
		withTmpAgentDir(async (svc, dir) => {
			writeFileSync(
				join(dir, "models.json"),
				JSON.stringify({ providers: { openai: { baseUrl: "https://old.example.com/v1" } } }),
			);
			writeFileSync(join(dir, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "sk-x" } }));
			await svc.setProviderBaseUrl("openai", "");
			const saved = JSON.parse(readFileSync(join(dir, "models.json"), "utf-8"));
			expect(saved.providers.openai).toBeUndefined();
			// key 不传 = 不动 auth.json
			const auth = JSON.parse(readFileSync(join(dir, "auth.json"), "utf-8"));
			expect(auth.openai).toEqual({ type: "api_key", key: "sk-x" });
		}),
	);

	it("非内置 id 被拒绝；非法 baseUrl 被拒绝", async () => {
		const svc = makeService([]);
		await expect(svc.setProviderBaseUrl("my-proxy", "https://x.com/v1")).rejects.toThrow(/不是内置 provider/);
		const svc2 = makeService([]);
		await expect(svc2.setProviderBaseUrl("openai", "not-a-url")).rejects.toThrow(/http/);
	});
});
