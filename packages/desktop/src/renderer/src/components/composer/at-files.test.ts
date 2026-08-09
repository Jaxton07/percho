import { describe, expect, it } from "vitest";
import { extractAtToken, filterFiles, fuzzyScore } from "./at-files";

describe("extractAtToken", () => {
	it("行首 @ 触发", () => {
		expect(extractAtToken("@sr", 3)).toEqual({ start: 0, end: 3, query: "sr" });
	});
	it("空白后 @ 触发（含多行）", () => {
		expect(extractAtToken("看下 @com", 8)).toEqual({ start: 3, end: 8, query: "com" });
	});
	it("@ 前非空白不触发（邮箱）", () => {
		expect(extractAtToken("a@b.com", 7)).toBeNull();
	});
	it("query 含空白不触发", () => {
		expect(extractAtToken("@foo bar", 8)).toBeNull();
	});
	it("光标在 token 中间时按光标截断", () => {
		expect(extractAtToken("@foobar", 4)).toEqual({ start: 0, end: 4, query: "foo" });
	});
	it("无 @ 不触发", () => {
		expect(extractAtToken("hello", 5)).toBeNull();
	});
});

describe("fuzzyScore", () => {
	it("子序列命中", () => {
		expect(fuzzyScore("cmp", "src/components/Composer.tsx")).not.toBeNull();
	});
	it("未完整命中返回 null", () => {
		expect(fuzzyScore("xyz", "src/app.ts")).toBeNull();
	});
	it("连续命中优于分散命中", () => {
		const good = fuzzyScore("composer", "src/components/Composer.tsx");
		const bad = fuzzyScore("composer", "src/components/ModelPicker.tsx");
		expect(good).not.toBeNull();
		expect(bad).not.toBeNull();
		expect(good as number).toBeGreaterThan(bad as number);
	});
	it("大小写不敏感，驼峰有加分", () => {
		expect(fuzzyScore("composer", "Composer.tsx")).not.toBeNull();
	});
	it("空 query 得 0 分", () => {
		expect(fuzzyScore("", "anything.ts")).toBe(0);
	});
});

describe("filterFiles", () => {
	const files = [
		"src/",
		"src/components/",
		"src/components/Composer.tsx",
		"src/components/chat/",
		"src/components/chat/MessageList.tsx",
		"package.json",
		"README.md",
	];
	it("按评分排序并截断", () => {
		const out = filterFiles(files, "composer");
		expect(out[0]).toBe("src/components/Composer.tsx");
	});
	it("无匹配返回空", () => {
		expect(filterFiles(files, "zzzzz")).toEqual([]);
	});
	it("空 query 取前 limit 条遍历序", () => {
		expect(filterFiles(files, "", 3)).toEqual(files.slice(0, 3));
	});
	it("目录路径可作为 query 继续钻取", () => {
		const out = filterFiles(files, "src/components/chat/");
		expect(out).toContain("src/components/chat/MessageList.tsx");
	});
});
