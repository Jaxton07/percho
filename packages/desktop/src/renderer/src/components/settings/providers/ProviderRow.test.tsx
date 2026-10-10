import type { ModelPrefs, ProviderInfo } from "@percho/shared";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SwitchProps } from "../../ui/Switch";

const mock = vi.hoisted(() => ({
	modelPrefs: null as ModelPrefs | null,
	switches: [] as SwitchProps[],
	stateCalls: 0,
	setModelHidden: vi.fn(),
	setProviderModelsHidden: vi.fn(),
	setModelsHidden: vi.fn(),
}));
vi.mock("react", async () => {
	const actual = await vi.importActual<typeof import("react")>("react");
	return {
		...actual,
		useState: (initial: unknown) => {
			// 仅打开 ProviderRow 的第二个 state（模型列表）；其他 state 用真正的 SSR hooks。
			const slot = mock.stateCalls++;
			return actual.useState(slot === 1 ? true : initial);
		},
	};
});
vi.mock("../../../i18n", () => ({ useT: () => (key: string) => key }));
vi.mock("../../../stores/settings", () => ({
	useSettingsStore: (select: (s: unknown) => unknown) => select({ ...mock, testResults: {} }),
}));
vi.mock("../../../stores/provider-login", () => ({
	useProviderLoginStore: (select: (s: unknown) => unknown) => select({ login: null }),
}));
vi.mock("../../ui/Switch", async () => {
	const actual = await vi.importActual<typeof import("../../ui/Switch")>("../../ui/Switch");
	return {
		Switch: (props: SwitchProps) => {
			mock.switches.push(props);
			return React.createElement(actual.Switch, props);
		},
	};
});

import { ProviderRow } from "./ProviderRow";

const provider: ProviderInfo = {
	id: "p",
	name: "P",
	custom: false,
	configured: true,
	models: [
		{ id: "a", name: "A" },
		{ id: "b", name: "B" },
	],
};
const base = (): ModelPrefs => ({ hiddenModels: {}, subagentModels: {} });
function render(prefs: ModelPrefs, value = provider) {
	mock.modelPrefs = prefs;
	mock.switches = [];
	mock.stateCalls = 0;
	return renderToStaticMarkup(React.createElement(ProviderRow, { provider: value }));
}

beforeEach(() => {
	vi.clearAllMocks();
	// 本仓 Vitest 是 classic JSX；仅为本文件 SSR 提供 React，不改变全局测试配置。
	vi.stubGlobal("React", React);
});

afterEach(() => vi.unstubAllGlobals());

function switchAt(index: number): SwitchProps {
	const value = mock.switches[index];
	if (!value) throw new Error(`Missing switch ${index}`);
	return value;
}

describe("ProviderRow production switch wiring", () => {
	it("默认全显，整源开关只发 provider/hidden，不枚举 IDs", () => {
		const html = render(base());
		expect(mock.switches.map((s) => s.checked)).toEqual([true, true, true]);
		expect(html).toContain('aria-label="A"');
		switchAt(0).onCheckedChange(false);
		expect(mock.setProviderModelsHidden).toHaveBeenCalledWith("p", true);
		expect(mock.setModelsHidden).not.toHaveBeenCalled();
	});

	it("隐藏源按白名单画单项，混合态点击仍全藏；单项发送原模型 ID", () => {
		const html = render({ ...base(), hiddenProviders: ["p"], visibleModels: { p: ["a"] } });
		expect(mock.switches.map((s) => s.checked)).toEqual([false, true, false]);
		expect(html).toContain('aria-checked="mixed"');
		switchAt(0).onCheckedChange(true);
		expect(mock.setProviderModelsHidden).toHaveBeenCalledWith("p", true);
		switchAt(2).onCheckedChange(true);
		expect(mock.setModelHidden).toHaveBeenCalledWith("p", "b", false);
		switchAt(1).onCheckedChange(false);
		expect(mock.setModelHidden).toHaveBeenLastCalledWith("p", "a", true);
	});

	it("黑名单的混合态同样点击全藏", () => {
		render({ ...base(), hiddenModels: { p: ["a"] } });
		expect(switchAt(0).indeterminate).toBe(true);
		switchAt(0).onCheckedChange(true);
		expect(mock.setProviderModelsHidden).toHaveBeenCalledWith("p", true);
	});

	it("有效全藏（新策略或旧全名单）点击全显", () => {
		for (const prefs of [
			{ ...base(), hiddenProviders: ["p"] },
			{ ...base(), hiddenModels: { p: ["a", "b"] } },
		]) {
			render(prefs);
			expect(switchAt(0).checked).toBe(false);
			expect(switchAt(0).indeterminate).toBe(false);
			switchAt(0).onCheckedChange(true);
			expect(mock.setProviderModelsHidden).toHaveBeenLastCalledWith("p", false);
		}
	});

	it("白名单覆盖当前全部 ID 时源开关全显，目录增长后变混合且新项隐藏", () => {
		const prefs = { ...base(), hiddenProviders: ["p"], visibleModels: { p: ["a", "b"] } };
		render(prefs);
		expect(switchAt(0).checked).toBe(true);
		render(prefs, { ...provider, models: [...provider.models, { id: "new", name: "New" }] });
		expect(switchAt(0).indeterminate).toBe(true);
		expect(switchAt(3).checked).toBe(false);
	});

	it("零目录（即使未配置）可设置默认策略，不禁用开关或改凭证", () => {
		const zero = { ...provider, configured: false, models: [] };
		render(base(), zero);
		expect(mock.switches).toHaveLength(1);
		expect(switchAt(0).disabled).not.toBe(true);
		expect(switchAt(0).checked).toBe(true);
		switchAt(0).onCheckedChange(false);
		expect(mock.setProviderModelsHidden).toHaveBeenCalledWith("p", true);
		render({ ...base(), hiddenProviders: ["p"] }, zero);
		expect(switchAt(0).checked).toBe(false);
		switchAt(0).onCheckedChange(true);
		expect(mock.setProviderModelsHidden).toHaveBeenLastCalledWith("p", false);
	});
});
