import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { applyToolAnnotationsRule } from "../src/permissions/annotations";
import type { PermissionRules } from "../src/permissions/pattern";

/** 造 ToolInfo（只填判定用得上的字段） */
function info(
	name: string,
	options: { path?: string; readOnlyHint?: boolean; destructiveHint?: boolean } = {},
): ToolInfo {
	return {
		name,
		description: "x",
		parameters: {},
		sourceInfo: { path: options.path ?? `builtin:${name}` },
		annotations:
			options.readOnlyHint === undefined && options.destructiveHint === undefined
				? undefined
				: { readOnlyHint: options.readOnlyHint, destructiveHint: options.destructiveHint },
	} as unknown as ToolInfo;
}

const DEFAULT_RULES: PermissionRules = { "*": "allow" } as unknown as PermissionRules;

function decide(toolName: string, tools: ToolInfo[], rules: PermissionRules = DEFAULT_RULES) {
	return applyToolAnnotationsRule(rules, toolName, "allow", (name) => tools.find((t) => t.name === name));
}

describe("非内置工具的声明层判定（spec §3.1-7）", () => {
	it("MCP 工具声明 readOnlyHint → 放行（不弹窗）", () => {
		const tools = [info("mcp__docs__search", { path: "builtin:mcp", readOnlyHint: true })];
		expect(decide("mcp__docs__search", tools)).toBe("allow");
	});

	it("MCP 工具没声明 annotations → ask", () => {
		const tools = [info("mcp__docs__write", { path: "builtin:mcp" })];
		expect(decide("mcp__docs__write", tools)).toBe("ask");
	});

	it("MCP 工具显式 readOnlyHint=false → ask", () => {
		const tools = [info("mcp__docs__write", { path: "builtin:mcp", readOnlyHint: false })];
		expect(decide("mcp__docs__write", tools)).toBe("ask");
	});

	it("第三方盘上扩展工具（sourceInfo 是文件路径、无 annotations）→ ask", () => {
		const tools = [info("my_tool", { path: "/Users/x/.pi/agent/extensions/my-ext.ts" })];
		expect(decide("my_tool", tools)).toBe("ask");
	});

	it("工具表里查不到（未知工具）→ ask（fail-safe）", () => {
		expect(decide("ghost_tool", [])).toBe("ask");
	});

	it("受信内置不看 annotations：SDK 自带（名单）与 Percho 自研（<sdk:/<inline:>）都放行", () => {
		// SDK 自带：连工具表都不查（元数据缺失也不会误弹）
		expect(decide("bash", [])).toBe("allow");
		expect(decide("write", [])).toBe("allow");
		// Percho 的 customTools（<sdk:…>）与 inline 扩展工具（<inline:…>）：声明为写也放行（走硬编码分类）
		expect(
			decide("channel_post", [info("channel_post", { path: "<inline:channel-watch>", readOnlyHint: false })]),
		).toBe("allow");
		expect(decide("subagent", [info("subagent", { path: "<sdk:subagent>", readOnlyHint: false })])).toBe(
			"allow",
		);
	});

	it("显式规则优先：同一条 MCP 工具，用户写 allow → 放行；写 deny → 维持 deny 判定", () => {
		const tools = [info("mcp__docs__write", { path: "builtin:mcp" })];
		expect(
			decide("mcp__docs__write", tools, {
				"*": "allow",
				mcp__docs__write: "allow",
			} as unknown as PermissionRules),
		).toBe("allow");
		// deny/ask 在规则层已经是终局判定 → 声明层不再参与（这里模拟规则已给出 ask 的情况）
		expect(applyToolAnnotationsRule(DEFAULT_RULES, "mcp__docs__write", "ask", () => tools[0])).toBe("ask");
	});

	it("规则已给出 ask（如 codemode 默认规则）→ 声明层不改写", () => {
		const tools = [info("codemode", { path: "builtin:codemode" })];
		const rules = { "*": "allow", codemode: "ask" } as unknown as PermissionRules;
		expect(applyToolAnnotationsRule(rules, "codemode", "ask", (n) => tools.find((t) => t.name === n))).toBe(
			"ask",
		);
		expect(applyToolAnnotationsRule(rules, "codemode", "deny", () => tools[0])).toBe("deny");
	});
});
