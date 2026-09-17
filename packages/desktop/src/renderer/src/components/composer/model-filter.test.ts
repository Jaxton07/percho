import type { AvailableModel } from "@percho/shared";
import { describe, expect, it } from "vitest";
import { filterModelGroups, type ModelGroup } from "./model-filter";

function model(provider: string, providerName: string, id: string, label: string): AvailableModel {
	return { provider, providerName, id, label, authed: true };
}

const groups: ModelGroup[] = [
	{
		name: "Anthropic",
		items: [
			model("anthropic", "Anthropic", "claude-opus-4-5", "Claude Opus 4.5"),
			model("anthropic", "Anthropic", "claude-haiku-3-5", "Claude 3.5 Haiku"),
		],
	},
	{
		name: "DeepSeek",
		items: [model("deepseek", "DeepSeek", "deepseek-chat", "DeepSeek Chat")],
	},
];

describe("filterModelGroups", () => {
	it("空 query 原样返回（同一引用，避免无谓重渲染）", () => {
		expect(filterModelGroups(groups, "")).toBe(groups);
		expect(filterModelGroups(groups, "   ")).toBe(groups);
	});

	it("匹配 label（大小写不敏感）", () => {
		const result = filterModelGroups(groups, "HAIKU");
		expect(result).toHaveLength(1);
		expect(result[0]?.name).toBe("Anthropic");
		expect(result[0]?.items.map((m) => m.id)).toEqual(["claude-haiku-3-5"]);
	});

	it("匹配 provider 显示名与 provider id", () => {
		expect(filterModelGroups(groups, "deepseek")[0]?.items).toHaveLength(1);
		expect(filterModelGroups(groups, "Anthropic")[0]?.items).toHaveLength(2);
	});

	it("空格分词：所有词都要命中（label / provider 名可跨字段）", () => {
		expect(filterModelGroups(groups, "claude haiku")[0]?.items.map((m) => m.id)).toEqual([
			"claude-haiku-3-5",
		]);
		expect(filterModelGroups(groups, "anthropic opus")[0]?.items.map((m) => m.id)).toEqual([
			"claude-opus-4-5",
		]);
	});

	it("无结果返回空数组（组被丢弃，不返回空组）", () => {
		expect(filterModelGroups(groups, "gpt")).toEqual([]);
		expect(filterModelGroups(groups, "claude gpt")).toEqual([]);
	});

	it("保持分组与组内原有顺序", () => {
		const result = filterModelGroups(groups, "claude");
		expect(result.map((g) => g.name)).toEqual(["Anthropic"]);
		expect(result[0]?.items.map((m) => m.id)).toEqual(["claude-opus-4-5", "claude-haiku-3-5"]);
	});
});
