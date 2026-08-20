import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ModelPrefs } from "@percho/shared";

const EMPTY_PREFS: ModelPrefs = { hiddenModels: {}, subagentModels: {} };

function copyPrefs(prefs: ModelPrefs): ModelPrefs {
	return {
		hiddenModels: Object.fromEntries(
			Object.entries(prefs.hiddenModels).map(([provider, ids]) => [provider, [...ids]]),
		),
		subagentModels: { ...prefs.subagentModels },
	};
}

function normalizeStringMap(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return Object.fromEntries(
		Object.entries(value).flatMap(([key, item]) => {
			const cleanKey = key.trim();
			const cleanValue = typeof item === "string" ? item.trim() : "";
			return cleanKey && cleanValue ? [[cleanKey, cleanValue]] : [];
		}),
	);
}

function normalizeHiddenModels(value: unknown): Record<string, string[]> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return Object.fromEntries(
		Object.entries(value).flatMap(([provider, ids]) => {
			const cleanProvider = provider.trim();
			if (!cleanProvider || !Array.isArray(ids)) return [];
			const cleanIds = [
				...new Set(ids.filter((id): id is string => typeof id === "string").map((id) => id.trim())),
			]
				.filter(Boolean)
				.sort();
			return cleanIds.length ? [[cleanProvider, cleanIds]] : [];
		}),
	);
}

/** 用户级模型偏好（<agentDir>/model-prefs.json）：隐藏模型 + 子代理指定模型。 */
export class ModelPrefsService {
	private cache: ModelPrefs | null = null;

	constructor(private readonly configPath: string) {}

	private async read(): Promise<ModelPrefs> {
		if (this.cache) return this.cache;
		let prefs = copyPrefs(EMPTY_PREFS);
		try {
			const data = JSON.parse(await readFile(this.configPath, "utf8")) as Partial<ModelPrefs>;
			prefs = {
				hiddenModels: normalizeHiddenModels(data.hiddenModels),
				subagentModels: normalizeStringMap(data.subagentModels),
			};
		} catch {
			// 文件不存在或损坏：安全地回退为空配置
		}
		this.cache = prefs;
		return prefs;
	}

	private async write(prefs: ModelPrefs): Promise<void> {
		this.cache = prefs;
		const dir = dirname(this.configPath);
		await mkdir(dir, { recursive: true });
		const tmp = join(dir, `.${Math.random().toString(36).slice(2)}.model-prefs.tmp`);
		await writeFile(tmp, `${JSON.stringify(prefs, null, 2)}\n`, "utf8");
		await rename(tmp, this.configPath);
	}

	async getPrefs(): Promise<ModelPrefs> {
		return copyPrefs(await this.read());
	}

	async isModelHidden(provider: string, modelId: string): Promise<boolean> {
		return (await this.read()).hiddenModels[provider]?.includes(modelId) ?? false;
	}

	async setModelHidden(provider: string, modelId: string, hidden: boolean): Promise<ModelPrefs> {
		const cleanProvider = provider.trim();
		const cleanModelId = modelId.trim();
		if (!cleanProvider || !cleanModelId) throw new Error("provider and modelId are required");
		const prefs = copyPrefs(await this.read());
		const ids = new Set(prefs.hiddenModels[cleanProvider] ?? []);
		if (hidden) ids.add(cleanModelId);
		else ids.delete(cleanModelId);
		if (ids.size) prefs.hiddenModels[cleanProvider] = [...ids].sort();
		else delete prefs.hiddenModels[cleanProvider];
		await this.write(prefs);
		return copyPrefs(prefs);
	}

	async setSubagentModel(agent: string, modelRef: string | null): Promise<ModelPrefs> {
		const cleanAgent = agent.trim();
		if (!cleanAgent) throw new Error("agent is required");
		const prefs = copyPrefs(await this.read());
		const cleanModelRef = modelRef?.trim() ?? "";
		if (cleanModelRef) prefs.subagentModels[cleanAgent] = cleanModelRef;
		else delete prefs.subagentModels[cleanAgent];
		await this.write(prefs);
		return copyPrefs(prefs);
	}

	async getSubagentModel(agent: string): Promise<string | undefined> {
		return (await this.read()).subagentModels[agent];
	}
}
