import {
	isModelVisible,
	type ModelPrefs,
	normalizeModelVisibility,
	providerModelVisibility,
	withModelHidden,
	withModelsHidden,
	withProviderModelsHidden,
} from "@percho/shared";
import { describe, expect, it } from "vitest";

const empty = (): ModelPrefs => ({ hiddenModels: {}, subagentModels: {} });

describe("shared model visibility", () => {
	it("旧 ID 名单不迁移为全源默认隐藏，目录增长时仍显示新 ID", () => {
		const prefs = { ...empty(), hiddenModels: { p: ["a", "b"] } };
		expect(providerModelVisibility(prefs, "p", ["a", "b"])).toBe("hidden");
		expect(providerModelVisibility(prefs, "p", ["a", "b", "new"])).toBe("mixed");
		expect(normalizeModelVisibility(prefs)).toEqual({ hiddenModels: { p: ["a", "b"] } });
		expect(isModelVisible(prefs, "p", "new")).toBe(true);
	});

	it("全藏→选一个→目录增长仍全藏默认；例外不会解除源默认", () => {
		const hidden = withProviderModelsHidden(empty(), "p", true);
		expect(isModelVisible(hidden, "p", "new")).toBe(false);
		const selected = withModelHidden(hidden, "p", "a", false);
		expect(selected.hiddenProviders).toEqual(["p"]);
		expect(selected.visibleModels).toEqual({ p: ["a"] });
		expect(isModelVisible(selected, "p", "a")).toBe(true);
		expect(isModelVisible(selected, "p", "new")).toBe(false);
		expect(providerModelVisibility(selected, "p", ["a"])).toBe("visible");
		expect(providerModelVisibility(selected, "p", ["a", "new"])).toBe("mixed");
		const deselected = withModelHidden(selected, "p", "a", true);
		expect(deselected.visibleModels).toBeUndefined();
		expect(deselected.hiddenProviders).toEqual(["p"]);
	});

	it("整源全显/全藏清空具体 ID 名单，只清理目标源", () => {
		const prefs: ModelPrefs = {
			...empty(),
			hiddenModels: { p: ["old"], other: ["keep"] },
			hiddenProviders: ["p", "q"],
			visibleModels: { p: ["a"], q: ["keep"] },
		};
		const all = withProviderModelsHidden(prefs, "p", false);
		expect(all.hiddenProviders).toEqual(["q"]);
		expect(all.hiddenModels).toEqual({ other: ["keep"] });
		expect(all.visibleModels).toEqual({ q: ["keep"] });
		expect(isModelVisible(all, "p", "old")).toBe(true);
		expect(isModelVisible(all, "p", "new")).toBe(true);
		const hidden = withProviderModelsHidden(prefs, "p", true);
		expect(hidden.hiddenProviders).toEqual(["p", "q"]);
		expect(hidden.hiddenModels).toEqual({ other: ["keep"] });
		expect(hidden.visibleModels).toEqual({ q: ["keep"] });
	});

	it("默认显示源沿用黑名单；批量只修改指定 IDs，不写全源策略", () => {
		const one = withModelsHidden(empty(), " p ", [" b ", "a", "a", ""], true);
		expect(one.hiddenModels).toEqual({ p: ["a", "b"] });
		expect(one.hiddenProviders).toBeUndefined();
		const shown = withModelsHidden(one, "p", ["a"], false);
		expect(shown.hiddenModels).toEqual({ p: ["b"] });
		expect(isModelVisible(shown, "p", "new")).toBe(true);
	});

	it("默认隐藏源批量采用白名单语义，显示当前所有 ID 仍不放出新 ID", () => {
		const hidden = withProviderModelsHidden(empty(), "p", true);
		const shown = withModelsHidden(hidden, "p", ["a", "b"], false);
		expect(shown.visibleModels).toEqual({ p: ["a", "b"] });
		expect(shown.hiddenProviders).toEqual(["p"]);
		expect(isModelVisible(shown, "p", "new")).toBe(false);
		expect(withModelsHidden(shown, "p", ["a"], true).visibleModels).toEqual({ p: ["b"] });
	});

	it("三态及零模型策略以有效可见性为准", () => {
		const hidden = withProviderModelsHidden(empty(), "p", true);
		expect(providerModelVisibility(hidden, "p", [])).toBe("hidden");
		expect(providerModelVisibility(empty(), "p", [])).toBe("visible");
		expect(providerModelVisibility(hidden, "p", ["a", "b"])).toBe("hidden");
		expect(providerModelVisibility(withModelHidden(hidden, "p", "a", false), "p", ["a", "b"])).toBe("mixed");
		expect(providerModelVisibility(withModelsHidden(hidden, "p", ["a", "b"], false), "p", ["a", "b"])).toBe(
			"visible",
		);
		expect(providerModelVisibility(withProviderModelsHidden(hidden, "p", false), "p", [])).toBe("visible");
	});

	it("normalize 去空/trim/合并重名键/去重/排序，删除非隐藏源白名单", () => {
		expect(
			normalizeModelVisibility({
				hiddenProviders: [" q ", "p", "p", "", 5],
				hiddenModels: { " p ": [" b ", "a", "", 1], p: ["c", "a"], " ": ["x"], bad: 3 },
				visibleModels: { p: ["b", " a ", "a"], q: [], orphan: ["x"] },
			}),
		).toEqual({
			hiddenModels: { p: ["a", "b", "c"] },
			hiddenProviders: ["p", "q"],
			visibleModels: { p: ["a", "b"] },
		});
		expect(normalizeModelVisibility({ hiddenProviders: [], visibleModels: { p: ["x"] } })).toEqual({
			hiddenModels: {},
		});
	});

	it.each([null, [], 3, { hiddenModels: [], hiddenProviders: {}, visibleModels: [] }])(
		"脏根/字段安全回退：%j",
		(raw) => {
			expect(normalizeModelVisibility(raw)).toEqual({ hiddenModels: {} });
		},
	);

	it.each(["constructor", "__proto__", "toString"])("provider 键 %s 不误用对象原型", (provider) => {
		expect(isModelVisible(empty(), provider, "a")).toBe(true);
		const one = withModelHidden(empty(), provider, "a", true);
		expect(isModelVisible(one, provider, "a")).toBe(false);
		const hidden = withProviderModelsHidden(empty(), provider, true);
		expect(isModelVisible(withModelHidden(hidden, provider, "a", false), provider, "a")).toBe(true);
	});

	it("纯变更不修改输入，也保留子代理字段", () => {
		const prefs: ModelPrefs = {
			...empty(),
			subagentModels: { scout: "p/a" },
			subagentThinking: { scout: "high" },
			subagentPreferBuiltin: false,
		};
		Object.freeze(prefs);
		Object.freeze(prefs.hiddenModels);
		Object.freeze(prefs.subagentModels);
		const changed = withModelHidden(prefs, "p", "a", true);
		expect(prefs.hiddenModels).toEqual({});
		expect(changed).toMatchObject({
			subagentModels: { scout: "p/a" },
			subagentThinking: { scout: "high" },
			subagentPreferBuiltin: false,
		});
		expect(changed).not.toBe(prefs);
	});

	it("拒绝空 provider / 单模型 ID；空批量不改变可见性", () => {
		expect(() => withProviderModelsHidden(empty(), " ", true)).toThrow(/provider/);
		expect(() => withModelHidden(empty(), "p", " ", true)).toThrow(/modelId/);
		expect(withModelsHidden(empty(), "p", [], true)).toEqual(empty());
	});
});
