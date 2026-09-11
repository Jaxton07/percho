import { isThinkingLevel, type ModelPrefs } from "@percho/shared";
import { JsonStore } from "../json-store";

function copyPrefs(prefs: ModelPrefs): ModelPrefs {
	const copy: ModelPrefs = {
		hiddenModels: Object.fromEntries(
			Object.entries(prefs.hiddenModels).map(([provider, ids]) => [provider, [...ids]]),
		),
		subagentModels: { ...prefs.subagentModels },
	};
	// 可缺省字段：无非空内容时不写进 json（向后兼容旧文件；读侧仍视作缺省）
	if (prefs.subagentThinking && Object.keys(prefs.subagentThinking).length > 0) {
		copy.subagentThinking = { ...prefs.subagentThinking };
	}
	if (prefs.subagentPreferBuiltin !== undefined) copy.subagentPreferBuiltin = prefs.subagentPreferBuiltin;
	return copy;
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

/** 思考深度覆盖：先按 string map 规整（trim/丢空），再白名单过滤非 7 档脏值。 */
function normalizeThinkingMap(value: unknown): Record<string, string> {
	return Object.fromEntries(
		Object.entries(normalizeStringMap(value)).filter(([, level]) => isThinkingLevel(level)),
	);
}

/** 用户级模型偏好（<agentDir>/model-prefs.json）：隐藏模型 + 子代理指定模型/思考深度 + 执行器偏好。 */
export class ModelPrefsService {
	private cache: ModelPrefs | null = null;

	constructor(private readonly configPath: string) {}

	private store(): JsonStore<Partial<ModelPrefs>> {
		return new JsonStore<Partial<ModelPrefs>>({
			path: this.configPath,
			defaultValue: () => ({}),
		});
	}

	private async read(): Promise<ModelPrefs> {
		if (this.cache) return this.cache;
		// 损坏/缺失回退空配置（JsonStore 保证）；字段级规整仍在服务层
		const data = await this.store().read();
		const thinking = normalizeThinkingMap(data.subagentThinking);
		const prefs: ModelPrefs = {
			hiddenModels: normalizeHiddenModels(data.hiddenModels),
			subagentModels: normalizeStringMap(data.subagentModels),
		};
		if (Object.keys(thinking).length > 0) prefs.subagentThinking = thinking;
		// 非 boolean 脏值按缺省处理（读取方一律 `!== false` → true）
		if (typeof data.subagentPreferBuiltin === "boolean") {
			prefs.subagentPreferBuiltin = data.subagentPreferBuiltin;
		}
		this.cache = prefs;
		return prefs;
	}

	private async write(prefs: ModelPrefs): Promise<void> {
		this.cache = prefs;
		await this.store().write(prefs);
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

	async setModelsHidden(provider: string, modelIds: string[], hidden: boolean): Promise<ModelPrefs> {
		const cleanProvider = provider.trim();
		if (!cleanProvider) throw new Error("provider is required");
		const ids = [...new Set(modelIds.map((id) => id.trim()).filter(Boolean))].sort();
		if (!ids.length) return copyPrefs(await this.read());
		const prefs = copyPrefs(await this.read());
		const set = new Set(prefs.hiddenModels[cleanProvider] ?? []);
		if (hidden) {
			for (const id of ids) set.add(id);
		} else {
			for (const id of ids) set.delete(id);
		}
		if (set.size) prefs.hiddenModels[cleanProvider] = [...set].sort();
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

	/** 设置页的思考深度覆盖；无键 = 跟随 agent 定义（undefined）。 */
	async getSubagentThinking(agent: string): Promise<string | undefined> {
		return (await this.read()).subagentThinking?.[agent];
	}

	async setSubagentThinking(agent: string, level: string | null): Promise<ModelPrefs> {
		const cleanAgent = agent.trim();
		if (!cleanAgent) throw new Error("agent is required");
		const cleanLevel = level?.trim() ?? "";
		if (cleanLevel && !isThinkingLevel(cleanLevel)) throw new Error(`invalid thinking level: ${cleanLevel}`);
		const prefs = copyPrefs(await this.read());
		const thinking = { ...(prefs.subagentThinking ?? {}) };
		if (cleanLevel) thinking[cleanAgent] = cleanLevel;
		else delete thinking[cleanAgent];
		if (Object.keys(thinking).length > 0) prefs.subagentThinking = thinking;
		else delete prefs.subagentThinking;
		await this.write(prefs);
		return copyPrefs(prefs);
	}

	/** 内置 subagent 执行器优先；缺省/脏值一律 true（保持现状语义）。 */
	async getSubagentPreferBuiltin(): Promise<boolean> {
		return (await this.read()).subagentPreferBuiltin !== false;
	}

	async setSubagentPreferBuiltin(enabled: boolean): Promise<ModelPrefs> {
		const prefs = copyPrefs(await this.read());
		prefs.subagentPreferBuiltin = enabled;
		await this.write(prefs);
		return copyPrefs(prefs);
	}
}
