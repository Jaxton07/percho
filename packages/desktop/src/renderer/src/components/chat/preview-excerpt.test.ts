import { previewExcerpt } from "@percho/shared";
import { describe, expect, it } from "vitest";

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
});
