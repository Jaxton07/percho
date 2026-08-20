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
});
