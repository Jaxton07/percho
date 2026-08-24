// @vitest-environment node
import type { UiPluginContribution } from "@percho/shared";
import { describe, expect, it } from "vitest";
import { filterContributions } from "./manager";

/** filterContributions 纯函数测试：坏 manifest 的 contributions 防御（B2 配套） */

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
