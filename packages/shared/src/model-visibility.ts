import type { ModelPrefs } from "./settings";

export type ModelVisibilityPrefs = Pick<ModelPrefs, "hiddenModels" | "hiddenProviders" | "visibleModels">;
export type ProviderModelVisibility = "visible" | "hidden" | "mixed";

function cleanIds(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return [...new Set(value.filter((id): id is string => typeof id === "string").map((id) => id.trim()))]
		.filter(Boolean)
		.sort();
}

function cleanModelMap(value: unknown): Record<string, string[]> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const entries = new Map<string, string[]>();
	for (const [provider, ids] of Object.entries(value)) {
		const key = provider.trim();
		if (!key) continue;
		const merged = cleanIds([...(entries.get(key) ?? []), ...cleanIds(ids)]);
		if (merged.length) entries.set(key, merged);
	}
	return Object.fromEntries([...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** 旧名单只表示具体 ID，不推测全源意图；空可选字段不保留。 */
export function normalizeModelVisibility(value: unknown): ModelVisibilityPrefs {
	const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
	const data = raw as Partial<ModelVisibilityPrefs>;
	const result: ModelVisibilityPrefs = { hiddenModels: cleanModelMap(data.hiddenModels) };
	const providers = cleanIds(data.hiddenProviders);
	if (providers.length) result.hiddenProviders = providers;
	const visible = Object.fromEntries(
		Object.entries(cleanModelMap(data.visibleModels)).filter(([provider]) => providers.includes(provider)),
	);
	if (Object.keys(visible).length) result.visibleModels = visible;
	return result;
}

function idsFor(map: Record<string, string[]> | undefined, provider: string): string[] {
	return map && Object.hasOwn(map, provider) ? (map[provider] ?? []) : [];
}

/** 唯一有效可见性规则（隐藏只影响选择列表，不是执行/认证权限）。 */
export function isModelVisible(prefs: ModelVisibilityPrefs, provider: string, modelId: string): boolean {
	if (prefs.hiddenProviders?.includes(provider))
		return idsFor(prefs.visibleModels, provider).includes(modelId);
	return !idsFor(prefs.hiddenModels, provider).includes(modelId);
}

/** 零模型时按源默认策略显示开关，不从目录内容猜意图。 */
export function providerModelVisibility(
	prefs: ModelVisibilityPrefs,
	provider: string,
	modelIds: readonly string[],
): ProviderModelVisibility {
	if (!modelIds.length) return prefs.hiddenProviders?.includes(provider) ? "hidden" : "visible";
	const visible = modelIds.filter((id) => isModelVisible(prefs, provider, id)).length;
	return visible === modelIds.length ? "visible" : visible === 0 ? "hidden" : "mixed";
}

function replaceVisibility(prefs: ModelPrefs, visibility: ModelVisibilityPrefs): ModelPrefs {
	const next = { ...prefs, ...visibility };
	if (!visibility.hiddenProviders) delete next.hiddenProviders;
	if (!visibility.visibleModels) delete next.visibleModels;
	return next;
}

/** 单模型/指定 IDs 批量修改，不改变源默认策略；返回新偏好，不修改输入。 */
export function withModelsHidden(
	prefs: ModelPrefs,
	provider: string,
	modelIds: readonly string[],
	hidden: boolean,
): ModelPrefs {
	const key = provider.trim();
	if (!key) throw new Error("provider is required");
	const visibility = normalizeModelVisibility(prefs);
	const defaultHidden = visibility.hiddenProviders?.includes(key) ?? false;
	const map = { ...(defaultHidden ? visibility.visibleModels : visibility.hiddenModels) };
	const ids = new Set(idsFor(map, key));
	for (const id of cleanIds(modelIds)) {
		if (hidden !== defaultHidden) ids.add(id);
		else ids.delete(id);
	}
	if (ids.size) {
		const updated = { ...map, [key]: [...ids].sort() };
		if (defaultHidden) visibility.visibleModels = updated;
		else visibility.hiddenModels = updated;
	} else {
		delete map[key];
		if (defaultHidden) visibility.visibleModels = map;
		else visibility.hiddenModels = map;
	}
	return replaceVisibility(prefs, normalizeModelVisibility(visibility));
}

export function withModelHidden(
	prefs: ModelPrefs,
	provider: string,
	modelId: string,
	hidden: boolean,
): ModelPrefs {
	if (!modelId.trim()) throw new Error("modelId is required");
	return withModelsHidden(prefs, provider, [modelId], hidden);
}

/** 整源操作直接记录默认策略，并清空该源两种具体 ID 名单。 */
export function withProviderModelsHidden(prefs: ModelPrefs, provider: string, hidden: boolean): ModelPrefs {
	const key = provider.trim();
	if (!key) throw new Error("provider is required");
	const visibility = normalizeModelVisibility(prefs);
	const providers = new Set(visibility.hiddenProviders ?? []);
	if (hidden) providers.add(key);
	else providers.delete(key);
	visibility.hiddenProviders = [...providers].sort();
	delete visibility.hiddenModels[key];
	if (visibility.visibleModels) delete visibility.visibleModels[key];
	return replaceVisibility(prefs, normalizeModelVisibility(visibility));
}
