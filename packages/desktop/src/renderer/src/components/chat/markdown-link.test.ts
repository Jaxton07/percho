import { describe, expect, it } from "vitest";
import { classifyMarkdownLink } from "./markdown-link";

describe("classifyMarkdownLink", () => {
	it("会话相对文件与绝对文件交给文件桥，而非 app 页面导航", () => {
		for (const target of [
			".local/docs/html/tenant-isolation-architecture.html",
			"../notes/a%20b.html",
			"/Users/me/project/report.html",
			"~/notes/a.md",
			"file:///Users/me/a%20b.html",
		]) {
			expect(classifyMarkdownLink(target)).toEqual({ kind: "file", target });
		}
	});
	it("网页链接在系统浏览器打开，页内锚点保留原生行为", () => {
		expect(classifyMarkdownLink("https://example.com/docs")).toEqual({
			kind: "external",
			url: "https://example.com/docs",
		});
		expect(classifyMarkdownLink("#section")).toEqual({ kind: "anchor" });
	});
	it("拒绝协议相对地址和不受支持的协议", () => {
		for (const url of ["//example.com", "javascript:alert(1)", "mailto:a@b.com", "data:text/html,x", ""]) {
			expect(classifyMarkdownLink(url)).toEqual({ kind: "unsupported" });
		}
	});
});
