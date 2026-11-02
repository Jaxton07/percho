// @vitest-environment node
import type { UiPluginContribution } from "@percho/shared";
import { describe, expect, it } from "vitest";
import { filterContributions, validateManifest } from "./manifest";

it("旧工具卡槽位拒绝整个清单，包含混合能力的插件", () => {
	for (const extra of [
		{},
		{ headless: true },
		{ contributions: [{ id: "overlay", region: "app.overlay", export: "Overlay" }] },
	]) {
		const manifest = {
			name: "old-card",
			perchoUi: 1,
			main: "src/index.tsx",
			slots: { "chat.tool-call-card": "OldCard", "chat.todo-panel": "Todo" },
			...extra,
		};
		const before = JSON.stringify(manifest);
		expect(validateManifest("old-card", manifest)).toBe("槽位 chat.tool-call-card 未知");
		expect(JSON.stringify(manifest)).toBe(before);
	}
});

/** filterContributions 纯函数测试：坏 manifest 的 contributions 防御（B2 配套；随实现迁至 manifest.ts） */

describe("filterContributions", () => {
	it("非数组输入（undefined / 对象 / 字符串）→ 空数组", () => {
		expect(filterContributions(undefined)).toEqual([]);
		expect(filterContributions({} as unknown as UiPluginContribution[])).toEqual([]);
		expect(filterContributions("nope" as unknown as UiPluginContribution[])).toEqual([]);
	});

	it("剔除未知 region 条目", () => {
		const input: UiPluginContribution[] = [
			{ id: "a", region: "app.overlay", export: "Overlay" },
			{ id: "b", region: "future.region", export: "Future" },
		];
		expect(filterContributions(input)).toEqual([{ id: "a", region: "app.overlay", export: "Overlay" }]);
	});

	it("非 app.overlay 区域的 anchor 剥离，overlay 区域保留", () => {
		const input: UiPluginContribution[] = [
			{ id: "a", region: "app.overlay", export: "Overlay", anchor: "top-left" },
			{ id: "b", region: "chat.corner.top-right", export: "Corner", anchor: "top-right" },
		];
		expect(filterContributions(input)).toEqual([
			{ id: "a", region: "app.overlay", export: "Overlay", anchor: "top-left" },
			{ id: "b", region: "chat.corner.top-right", export: "Corner", anchor: undefined },
		]);
	});
});
