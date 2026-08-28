import { describe, expect, it } from "vitest";
import { extractSlashToken, removeSlashToken } from "./slash-filter";

describe("extractSlashToken", () => {
	it("行首 / 触发", () => {
		expect(extractSlashToken("/rev", 4)).toEqual({ start: 0, end: 4, query: "rev" });
		expect(extractSlashToken("/", 1)).toEqual({ start: 0, end: 1, query: "" });
	});
	it("空白后 / 触发（任意位置，中间插入）", () => {
		expect(extractSlashToken("帮我 /rev", 7)).toEqual({ start: 3, end: 7, query: "rev" });
		expect(extractSlashToken("a\n/rev", 6)).toEqual({ start: 2, end: 6, query: "rev" });
	});
	it("非空白后 / 不触发（防 URL/路径误伤）", () => {
		expect(extractSlashToken("帮我/rev", 7)).toBeNull();
		expect(extractSlashToken("see https://x.io/a", 18)).toBeNull();
	});
	it("query 含空白不触发（args 已输入，菜单让位正常编辑）", () => {
		expect(extractSlashToken("/rev me", 7)).toBeNull();
	});
	it("光标在 / 前（或 / 不在光标前）不触发", () => {
		expect(extractSlashToken("/rev", 0)).toBeNull();
		expect(extractSlashToken("abc /rev def", 4)).toBeNull();
	});
	it("多个 / 时就近取光标前最近一个", () => {
		expect(extractSlashToken("/skill:rev", 10)).toEqual({ start: 0, end: 10, query: "skill:rev" });
		expect(extractSlashToken("/a /b", 5)).toEqual({ start: 3, end: 5, query: "b" });
	});
});

describe("removeSlashToken", () => {
	it("移除 token，保留其余文字", () => {
		expect(removeSlashToken("帮我 /rev 审查这个 PR", { start: 3, end: 7, query: "rev" })).toBe(
			"帮我 审查这个 PR",
		);
	});
	it("两侧都空白时收掉一个空格", () => {
		expect(removeSlashToken("/rev 审查", { start: 0, end: 4, query: "rev" })).toBe("审查");
		expect(removeSlashToken("a /rev b", { start: 2, end: 6, query: "rev" })).toBe("a b");
	});
	it("token 后无文字时原样保留前文", () => {
		expect(removeSlashToken("帮我 /rev", { start: 3, end: 7, query: "rev" })).toBe("帮我 ");
	});
});
