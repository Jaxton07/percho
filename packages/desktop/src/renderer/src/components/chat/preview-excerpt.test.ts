import { previewExcerpt } from "@percho/shared";
import { describe, expect, it } from "vitest";

// 保留优化前的实现作为差分基准，尤其覆盖 slice 的特殊参数语义。
function originalExcerpt(text: string, max = 120): string {
	const plain = text
		.replace(/^\s*(```|~~~)[^\n]*$/gmu, " ")
		.replace(/`([^`]*)`/gu, "$1")
		.replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
		.replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
		.replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gmu, "")
		.replace(/(\*\*|\*|~~)(\S(?:.*?\S)?)\1/gu, "$2")
		.replace(/(?<![\p{L}\p{N}])(__|_)(\S(?:.*?\S)?)\1(?![\p{L}\p{N}])/gu, "$2");
	return Array.from(plain.replace(/\s+/gu, " ").trim()).slice(0, max).join("");
}

describe("previewExcerpt", () => {
	it("去掉代码围栏、行内代码、标题、列表、强调与链接标记", () => {
		const text =
			"## 结论\n\n示例代码如下：\n\n```ts\nexport const v0 = 0;\n```\n\n- 用 **`fetch`** 重试\n- 见 [文档](https://x.test)";
		expect(previewExcerpt(text)).toBe("结论 示例代码如下： export const v0 = 0; 用 fetch 重试 见 文档");
	});
	it("按码点截断、折叠空白", () => {
		expect(previewExcerpt(`  a\n\n b ${"汉".repeat(200)}`, 10)).toBe("a b 汉汉汉汉汉汉");
	});
	it("不误删正文里的下划线标识符", () => {
		expect(previewExcerpt("调用 snake_case_name 函数")).toBe("调用 snake_case_name 函数");
	});
	it("支持巨型普通正文的常规摘要长度", () => {
		const unit = "普通正文 😀 café\n";
		const expected = originalExcerpt(unit.repeat(40), 120);
		expect(previewExcerpt(unit.repeat(180000), 120)).toBe(expected);
	});
	it("与原实现保持一致，包括长正文、边界标记和特殊截断长度", () => {
		const texts = [
			// Still exceeds the 4096-unit fast-path boundary without allocating millions of
			// output code points for every negative/infinite slice parameter on CI.
			"普通正文 😀 café\n".repeat(600),
			`${"文".repeat(4095)}😀尾`,
			`${"文".repeat(4095)}*强调*`,
			`${"文".repeat(4090)}[链接](地址)`,
			`${"文".repeat(4090)}_强调_`,
			`${" ".repeat(5000)}正文`,
			`短文${" ".repeat(5000)}尾`,
			`${"文".repeat(4090)}\n1. 列表`,
			"`代码` ![图](地址) [链接](地址) snake_case _强调_ **强调**",
			"😀\ud800文字\udc00\n 结尾",
		];
		for (const text of texts) {
			for (const max of [0, -1, -Infinity, NaN, Infinity, 1, 1.9, 120, 4095, 5000]) {
				expect(previewExcerpt(text, max)).toBe(originalExcerpt(text, max));
			}
		}
	});
});
