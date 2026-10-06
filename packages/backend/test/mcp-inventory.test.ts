import { describe, expect, it } from "vitest";
import { collectMcpTools } from "../src/tools/mcp-inventory";

describe("collectMcpTools（运行态聚合 + 只读标记）", () => {
	it("按 server 分组并把 readOnlyHint 带出来；非 MCP 工具忽略", () => {
		const grouped = collectMcpTools([
			{ name: "mcp__demo__echo", readOnly: true },
			{ name: "mcp__demo__nuke" },
			{ name: "mcp__docs__search", readOnly: true },
			{ name: "todo", readOnly: true },
		]);
		expect([...grouped.keys()]).toEqual(["demo", "docs"]);
		expect(grouped.get("demo")).toEqual([
			{ name: "mcp__demo__echo", readOnly: true },
			{ name: "mcp__demo__nuke", readOnly: undefined },
		]);
		expect(grouped.get("docs")).toEqual([{ name: "mcp__docs__search", readOnly: true }]);
	});
});
