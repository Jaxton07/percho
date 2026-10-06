import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * 渲染端 vitest 默认跑在 node 环境（无 localStorage/navigator），而 tool-label 经 i18n 读它们。
 * 这里先打桩再**动态 import**（静态 import 会被提升到打桩之前），只为测显示名逻辑。
 */
type DisplayName = (name: string, t?: (key: string) => string) => string;
let displayName: DisplayName;

beforeAll(async () => {
	vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
	vi.stubGlobal("navigator", { language: "zh-CN" });
	({ displayName } = (await import("./tool-label")) as { displayName: DisplayName });
});

describe("工具显示名", () => {
	it("内置工具走翻译表", () => {
		expect(displayName("read", (key) => `[${key}]`)).toBe("[tool.names.read]");
	});

	it("MCP 工具保留命名空间：mcp__server__tool → server › tool", () => {
		expect(displayName("mcp__demo__echo")).toBe("demo › echo");
		// 不同 server 的同名工具不撞脸
		expect(displayName("mcp__docs__search")).not.toBe(displayName("mcp__web__search"));
	});

	it("其余扩展工具原名呈现；前缀不完整的不当 MCP 解析", () => {
		expect(displayName("third_party_tool")).toBe("third_party_tool");
		expect(displayName("mcp__broken")).toBe("mcp__broken");
		expect(displayName("mcp____tool")).toBe("mcp____tool");
	});
});
