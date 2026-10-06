import { describe, expect, it } from "vitest";
import { parseMcpNotice } from "../src/mcp/notices";

/**
 * 官方 mcp 扩展的 notify 文本形状（1.0.4 `extensions/mcp/index.js`）—— 面板「失败原因 / 需要登录」的数据源。
 * 解析不出来**不猜**（返回 undefined → 面板回落到「未连上」档），这些用例锁住这个边界。
 */
describe("parseMcpNotice（官方 mcp notify → 面板状态）", () => {
	it("「需要处理」聚合通知：逐行拆出 server 与原因，needs sign-in 归为需授权", () => {
		const update = parseMcpNotice(
			[
				"MCP servers need attention:",
				"  demo: failed: spawn npx ENOENT",
				"  github: needs sign-in",
				"Run /mcp to fix.",
			].join("\n"),
		);

		expect(update?.servers).toEqual([
			{ name: "demo", error: "spawn npx ENOENT" },
			{ name: "github", needsAuth: true },
		]);
	});

	it("config 行进全局提示（不带 server 名）", () => {
		const update = parseMcpNotice(
			"MCP servers need attention:\n  config: mcp.json: unexpected token\nRun /mcp to fix.",
		);
		expect(update?.servers).toEqual([]);
		expect(update?.global).toEqual({ level: "error", message: "mcp.json：mcp.json: unexpected token" });
	});

	it("登录生命周期：Sign in → needsAuth；Signed in → 清除标记", () => {
		expect(
			parseMcpNotice('Sign in to MCP server "github" in your browser:\nhttps://github.com/login/device'),
		).toEqual({
			servers: [{ name: "github", needsAuth: true, authUrl: "https://github.com/login/device" }],
		});
		expect(parseMcpNotice('Signed in to MCP server "github" (7 tools).')).toEqual({
			servers: [{ name: "github", clear: true }],
		});
	});

	it("整体加载失败 → 全局 error；工具不可达 → 全局 warning", () => {
		expect(parseMcpNotice("MCP failed to load: Unexpected token }").global).toEqual({
			level: "error",
			message: "Unexpected token }",
		});
		expect(
			parseMcpNotice(
				"MCP tools are only reachable from the codemode or tool_search tool, but neither is active. Enable one of them.",
			).global?.level,
		).toBe("warning");
	});

	it("不认识 / 空 / 只有信息级文本 → undefined（不猜）", () => {
		expect(parseMcpNotice("")).toBeUndefined();
		expect(
			parseMcpNotice("MCP servers are still connecting; their tools become available once connected."),
		).toEqual({
			servers: [],
			global: null,
		});
		expect(parseMcpNotice("some unrelated notification")).toBeUndefined();
		// 状态行里没有冒号 + 空格的形状 → 不解析成失败
		expect(
			parseMcpNotice("MCP servers need attention:\n  demo needs sign-in\nRun /mcp to fix.")?.servers,
		).toEqual([]);
	});
});
