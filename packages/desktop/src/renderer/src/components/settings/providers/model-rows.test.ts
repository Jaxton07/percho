import { describe, expect, it } from "vitest";
import {
	formatTokenCount,
	modelsToRows,
	parseTokenCount,
	rowsToModelInputs,
	rowsValid,
	splitPastedModelIds,
} from "./model-rows";

describe("parseTokenCount", () => {
	it("解析裸数字与 k 后缀", () => {
		expect(parseTokenCount("256000")).toBe(256000);
		expect(parseTokenCount("256k")).toBe(256000);
		expect(parseTokenCount("128K")).toBe(128000);
		expect(parseTokenCount(" 16k ")).toBe(16000);
		expect(parseTokenCount("1.5k")).toBe(1500);
	});

	it("拒绝非法输入", () => {
		expect(parseTokenCount("abc")).toBeNull();
		expect(parseTokenCount("0")).toBeNull();
		expect(parseTokenCount("-5")).toBeNull();
		expect(parseTokenCount("1.5")).toBeNull(); // 非整数
		expect(parseTokenCount("0.0001k")).toBeNull(); // 0.1 token 非整数
		expect(parseTokenCount("")).toBeNull();
	});
});

describe("formatTokenCount", () => {
	it("整千折叠为 k，其余原样", () => {
		expect(formatTokenCount(256000)).toBe("256k");
		expect(formatTokenCount(128000)).toBe("128k");
		expect(formatTokenCount(999)).toBe("999");
		expect(formatTokenCount(65536)).toBe("65536");
	});
});

describe("rowsValid / rowsToModelInputs", () => {
	it("至少要有一行带 id 的模型", () => {
		expect(
			rowsValid([{ id: "", contextWindow: "", maxTokens: "", reasoning: false, imageInput: false }]),
		).toBe(false);
		expect(
			rowsValid([{ id: "gpt-5", contextWindow: "", maxTokens: "", reasoning: false, imageInput: false }]),
		).toBe(true);
	});

	it("ctx/out 留空合法，非法值不合法", () => {
		const base = { id: "m1", reasoning: false, imageInput: false };
		expect(rowsValid([{ ...base, contextWindow: "abc", maxTokens: "" }])).toBe(false);
		expect(rowsValid([{ ...base, contextWindow: "256k", maxTokens: "64k" }])).toBe(true);
	});

	it("转换时丢弃空行、留空字段不落盘", () => {
		const inputs = rowsToModelInputs([
			{ id: " gpt-5.6-terra ", contextWindow: "256k", maxTokens: "", reasoning: true, imageInput: true },
			{ id: "", contextWindow: "", maxTokens: "", reasoning: false, imageInput: false },
			{ id: "gpt-5-mini", contextWindow: "", maxTokens: "16k", reasoning: false, imageInput: false },
		]);
		expect(inputs).toEqual([
			{ id: "gpt-5.6-terra", reasoning: true, contextWindow: 256000, maxTokens: undefined, imageInput: true },
			{
				id: "gpt-5-mini",
				reasoning: undefined,
				contextWindow: undefined,
				maxTokens: 16000,
				imageInput: undefined,
			},
		]);
	});
});

describe("modelsToRows", () => {
	it("从 ProviderInfo.models 预填，保留未设置状态", () => {
		expect(
			modelsToRows([
				{ id: "a", name: "a", reasoning: true, contextWindow: 256000 },
				{ id: "b", name: "b" },
			]),
		).toEqual([
			{ id: "a", contextWindow: "256k", maxTokens: "", reasoning: true, imageInput: false },
			{ id: "b", contextWindow: "", maxTokens: "", reasoning: false, imageInput: false },
		]);
	});

	it("空列表兜底一个空行", () => {
		expect(modelsToRows([])).toEqual([
			{ id: "", contextWindow: "", maxTokens: "", reasoning: false, imageInput: false },
		]);
	});
});

describe("splitPastedModelIds", () => {
	it("逗号/换行拆分，普通文本返回 null", () => {
		expect(splitPastedModelIds("gpt-5, gpt-5-mini\ngpt-5-nano")).toEqual([
			"gpt-5",
			"gpt-5-mini",
			"gpt-5-nano",
		]);
		expect(splitPastedModelIds("gpt-5")).toBeNull();
		expect(splitPastedModelIds(",,\n")).toBeNull();
	});
});
