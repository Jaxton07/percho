import type { UIToolCall } from "@percho/shared";
import { categoryOf, dotsFromItems, summarizeCategories } from "@percho/shared";
import { describe, expect, it } from "vitest";

function tool(name: string, state: UIToolCall["state"] = "done", key = name): UIToolCall {
	return { key, id: key, name, args: "{}", output: "", state };
}

describe("categoryOf", () => {
	it("内置工具映射到语义类目", () => {
		expect(categoryOf("read")).toBe("read");
		expect(categoryOf("edit")).toBe("edit");
		expect(categoryOf("write")).toBe("edit");
		expect(categoryOf("ls")).toBe("explore");
		expect(categoryOf("glob")).toBe("explore");
		expect(categoryOf("grep")).toBe("search");
		expect(categoryOf("bash")).toBe("bash");
	});

	it("未知工具归 other（含中文/自定义名）", () => {
		expect(categoryOf("webfetch")).toBe("other");
		expect(categoryOf("editor")).toBe("other");
		expect(categoryOf("show_image")).toBe("other");
	});
});

describe("dotsFromItems", () => {
	it("每个 tool call 一粒，按组内顺序展开，状态原样透传", () => {
		const dots = dotsFromItems([
			{ tools: [tool("read", "done", "t1"), tool("bash", "running", "t2")] },
			{ tools: [tool("grep", "error", "t3")] },
		]);
		expect(dots).toEqual([
			{ key: "t1", state: "done" },
			{ key: "t2", state: "running" },
			{ key: "t3", state: "error" },
		]);
	});

	it("subagent 不产圆点（会被移出折叠区成独立行）", () => {
		const dots = dotsFromItems([{ tools: [tool("read", "done", "t1"), tool("subagent", "running", "t2")] }]);
		expect(dots).toEqual([{ key: "t1", state: "done" }]);
	});

	it("空组返回空数组", () => {
		expect(dotsFromItems([{ tools: [] }])).toEqual([]);
	});
});

describe("summarizeCategories", () => {
	it("edit/write 归并为「编辑」，ls/glob 归并为「探索」", () => {
		const segs = summarizeCategories([{ tools: [tool("edit"), tool("write"), tool("ls"), tool("glob")] }]);
		expect(segs).toEqual([
			{ key: "edit", category: "edit", name: "edit", count: 2 },
			{ key: "explore", category: "explore", name: "ls", count: 2 },
		]);
	});

	it("跨 items 聚合，首见顺序保持", () => {
		const segs = summarizeCategories([{ tools: [tool("bash")] }, { tools: [tool("read"), tool("bash")] }]);
		expect(segs.map((s) => [s.key, s.count])).toEqual([
			["bash", 2],
			["read", 1],
		]);
	});

	it("other 按原始工具名各自成段", () => {
		const segs = summarizeCategories([{ tools: [tool("webfetch"), tool("webfetch"), tool("todo")] }]);
		expect(segs.map((s) => [s.key, s.category, s.count])).toEqual([
			["webfetch", "other", 2],
			["todo", "other", 1],
		]);
	});

	it("subagent 不入工具统计，subagentCount 追加「子代理」汇总段", () => {
		expect(summarizeCategories([{ tools: [tool("subagent")] }])).toEqual([]);
		const segs = summarizeCategories([{ tools: [tool("read"), tool("subagent")] }], 2);
		expect(segs).toEqual([
			{ key: "read", category: "read", name: "read", count: 1 },
			{ key: "subagent", category: "subagent", name: "subagent", count: 2 },
		]);
		// 纯子代理轮也有自己的折叠状态行：空组仍产出汇总段作为卡片的时间锚点
		expect(summarizeCategories([{ tools: [] }], 1)).toEqual([
			{ key: "subagent", category: "subagent", name: "subagent", count: 1 },
		]);
		// 无 subagent 的组（subagentCount=0）不显示该段
		expect(summarizeCategories([{ tools: [tool("read")] }], 0)).toHaveLength(1);
	});

	it("error 工具照常计数（失败态由圆点行标识）", () => {
		const segs = summarizeCategories([{ tools: [tool("bash", "error")] }]);
		expect(segs).toEqual([{ key: "bash", category: "bash", name: "bash", count: 1 }]);
	});
});
