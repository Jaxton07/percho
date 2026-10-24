import { describe, expect, it } from "vitest";
import { localizeText, resolveFieldValue } from "./settings-schema";

/** 声明式设置的取值规则：类型不符回落默认值，select 残留选项回落默认值 */

const bool = { type: "boolean" as const, label: "Auto", default: true };
const text = { type: "string" as const, label: "Browser", default: "chrome" };
const num = { type: "number" as const, label: "Port", default: 9222, min: 1024 };
const sel = {
	type: "select" as const,
	label: "Profile",
	default: "a",
	options: [
		{ value: "a", label: "A" },
		{ value: "b", label: "B" },
	],
};

describe("localizeText", () => {
	it("字符串原样返回；{zh,en} 按语言取；undefined → 空串", () => {
		expect(localizeText("hi", "zh")).toBe("hi");
		expect(localizeText({ zh: "你好", en: "Hello" }, "zh")).toBe("你好");
		expect(localizeText({ zh: "你好", en: "Hello" }, "en")).toBe("Hello");
		expect(localizeText(undefined, "en")).toBe("");
	});
});

describe("resolveFieldValue", () => {
	it("类型相符用已存值，不符回落默认值（不静默转换）", () => {
		expect(resolveFieldValue(bool, false)).toBe(false);
		expect(resolveFieldValue(bool, "true")).toBe(true); // 类型不符 → 默认值
		expect(resolveFieldValue(text, "firefox")).toBe("firefox");
		expect(resolveFieldValue(text, 1)).toBe("chrome");
		expect(resolveFieldValue(num, 8080)).toBe(8080);
		expect(resolveFieldValue(num, "8080")).toBe(9222);
	});

	it("select 的值必须是声明过的选项，否则回落默认值", () => {
		expect(resolveFieldValue(sel, "b")).toBe("b");
		expect(resolveFieldValue(sel, "ghost")).toBe("a");
	});

	it("没有默认值时给类型零值（boolean false / number 用 min / 其余空串）", () => {
		expect(resolveFieldValue({ type: "boolean", label: "x" }, undefined)).toBe(false);
		expect(resolveFieldValue({ type: "number", label: "x", min: 5 }, undefined)).toBe(5);
		expect(resolveFieldValue({ type: "string", label: "x" }, undefined)).toBe("");
	});

	it("已存值为 null 视同未设置", () => {
		expect(resolveFieldValue(bool, null)).toBe(true);
	});
});
