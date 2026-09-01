import { describe, expect, it } from "vitest";
import { buildQuoteBlock, quoteSummary } from "./quote";

describe("buildQuoteBlock", () => {
	it("空数组返回空串", () => {
		expect(buildQuoteBlock([])).toBe("");
	});

	it("单条单行", () => {
		expect(buildQuoteBlock(["深靛蓝/青绿氛围"])).toBe("> 深靛蓝/青绿氛围");
	});

	it("单条多行逐行加前缀", () => {
		expect(buildQuoteBlock(["第一行\n第二行"])).toBe("> 第一行\n> 第二行");
	});

	it("多条引用空行分隔", () => {
		expect(buildQuoteBlock(["甲", "乙"])).toBe("> 甲\n\n> 乙");
	});

	it("引用内的空行只留 > 防尾随空格", () => {
		expect(buildQuoteBlock(["上\n\n下"])).toBe("> 上\n>\n> 下");
	});
});

describe("quoteSummary", () => {
	it("折叠空白为单空格", () => {
		expect(quoteSummary("  a\n\nb\tc ")).toBe("a b c");
	});

	it("超长截断加省略号", () => {
		const out = quoteSummary("x".repeat(200));
		expect(out).toBe(`${"x".repeat(160)}…`);
	});
});
