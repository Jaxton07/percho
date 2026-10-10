import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ProviderInfo } from "@percho/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiBackend } from "../src/pi-backend";
import { ModelPrefsService } from "../src/settings/model-prefs";

const fixtureDirs: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(fixtureDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function visibilityBackend() {
	const root = fileURLToPath(
		new URL("../../../.local/tmp/issues-100-101-stage2/list-models", import.meta.url),
	);
	await mkdir(root, { recursive: true });
	const dir = await mkdtemp(join(root, "prefs-"));
	fixtureDirs.push(dir);
	const path = join(dir, "model-prefs.json");
	const service = new ModelPrefsService(path);
	const backend = new PiBackend({ projectTrust: false });
	Object.defineProperty(backend, "modelPrefs", { value: service, configurable: true });
	vi.spyOn(
		backend as unknown as { getModelRuntime: () => Promise<ModelRuntime> },
		"getModelRuntime",
	).mockResolvedValue(mockRuntime((_p, id) => textOnlyModel(id)));
	return { backend, service, path };
}

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
	it("真实偏好：全藏→单例外→目录增长→重启→全显均在唯一出口生效", async () => {
		const { backend, service, path } = await visibilityBackend();
		const directory = structuredClone(providers);
		const list = vi.spyOn(backend.settings, "listProviders").mockImplementation(async () => directory);
		await service.setProviderModelsHidden("fast", true);
		expect(await backend.listModels()).toEqual([]);
		await service.setModelHidden("fast", "flash", false);
		directory[0].models.push({ id: "new", name: "New" });
		expect((await backend.listModels()).map((m) => m.id)).toEqual(["flash"]);
		Object.defineProperty(backend, "modelPrefs", { value: new ModelPrefsService(path) });
		expect((await backend.listModels()).map((m) => m.id)).toEqual(["flash"]);
		await backend.modelPrefs.setProviderModelsHidden("fast", false);
		expect((await backend.listModels()).map((m) => m.id)).toEqual(["flash", "legacy", "new"]);
		// 保持默认目录入口：没有改为 forceNetwork，也不触碰会话 setModel。
		expect(list.mock.calls.every((args) => args.length === 0)).toBe(true);
	});

	it("旧全 ID 黑名单不推测源默认隐藏；批量操作也不产生默认策略", async () => {
		const { backend, service } = await visibilityBackend();
		const directory = structuredClone(providers);
		vi.spyOn(backend.settings, "listProviders").mockImplementation(async () => directory);
		await service.setModelsHidden("fast", ["flash", "legacy"], true);
		expect(await backend.listModels()).toEqual([]);
		directory[0].models.push({ id: "new", name: "New" });
		expect((await backend.listModels()).map((m) => m.id)).toEqual(["new"]);
		expect((await service.getPrefs()).hiddenProviders).toBeUndefined();
	});

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
