import type { Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ProviderInfo } from "@percho/shared";
import { describe, expect, it, vi } from "vitest";
import { PiBackend } from "../src/pi-backend";

const providers: ProviderInfo[] = [
	{
		id: "fast",
		name: "Fast",
		custom: false,
		configured: true,
		models: [
			{ id: "flash", name: "Flash" },
			{ id: "legacy", name: "Legacy" },
		],
	},
];

/** getModel 按 id 返回不同 input 能力的 mock runtime */
function mockRuntime(getModel: (provider: string, id: string) => unknown): ModelRuntime {
	return { getModel } as unknown as ModelRuntime;
}

function textOnlyModel(id: string): Model<any> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "fast",
		baseUrl: "https://example.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: {},
		contextWindow: 128_000,
		maxTokens: 8_192,
	} as Model<any>;
}

describe("PiBackend.listModels", () => {
	it("在唯一出口过滤隐藏模型", async () => {
		const backend = new PiBackend({ projectTrust: false });
		vi.spyOn(backend.settings, "listProviders").mockResolvedValue(providers);
		Object.defineProperty(backend, "modelPrefs", {
			value: { getPrefs: async () => ({ hiddenModels: { fast: ["legacy"] }, subagentModels: {} }) },
		});
		vi.spyOn(
			backend as unknown as { getModelRuntime: () => Promise<ModelRuntime> },
			"getModelRuntime",
		).mockResolvedValue({
			getModel: () => ({ provider: "fast", id: "flash" }) as Model<any>,
		} as ModelRuntime);

		expect(await backend.listModels()).toMatchObject([{ provider: "fast", id: "flash" }]);
	});

	it("imageInput：input 含 image 为 true，纯 text 为 false（fail-closed 数据源）", async () => {
		const backend = new PiBackend({ projectTrust: false });
		vi.spyOn(backend.settings, "listProviders").mockResolvedValue(providers);
		Object.defineProperty(backend, "modelPrefs", {
			value: { getPrefs: async () => ({ hiddenModels: {}, subagentModels: {} }) },
		});
		vi.spyOn(
			backend as unknown as { getModelRuntime: () => Promise<ModelRuntime> },
			"getModelRuntime",
		).mockResolvedValue(
			mockRuntime((_provider, id) =>
				id === "flash" ? { ...textOnlyModel(id), input: ["text", "image"] } : textOnlyModel(id),
			),
		);

		const models = await backend.listModels();
		const flash = models.find((m) => m.id === "flash");
		const legacy = models.find((m) => m.id === "legacy");
		expect(flash?.imageInput).toBe(true);
		expect(legacy?.imageInput).toBe(false);
	});

	it("imageInput：getModel 抳错/拿不到 → 字段缺省（UI fail-open 不拦截）", async () => {
		const backend = new PiBackend({ projectTrust: false });
		vi.spyOn(backend.settings, "listProviders").mockResolvedValue(providers);
		Object.defineProperty(backend, "modelPrefs", {
			value: { getPrefs: async () => ({ hiddenModels: {}, subagentModels: {} }) },
		});
		vi.spyOn(
			backend as unknown as { getModelRuntime: () => Promise<ModelRuntime> },
			"getModelRuntime",
		).mockResolvedValue(
			mockRuntime((_provider, id) => {
				if (id === "flash") throw new Error("not found");
				return undefined;
			}),
		);

		const models = await backend.listModels();
		expect(models.map((m) => m.imageInput)).toEqual([undefined, undefined]);
	});
});
