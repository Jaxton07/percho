import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
	vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
	vi.stubGlobal("navigator", { language: "zh" });
});
// SSR 固定读 Zustand **初始**快照（zustand v5 的 server snapshot 不跟随 setState），
// 所以这份测试只覆盖「初始态能渲染、不炸」；带数据的呈现用下面的纯函数测。
vi.mock("../../api", () => ({ getPi: () => ({ onMcpToolsChanged: () => () => {} }) }));

import { transportSummary } from "./McpPanel";

describe("McpPanel 纯呈现辅助", () => {
	it("传输方式摘要：stdio 拼 command+args，远程给 url，不完整给空串", () => {
		const base = {
			name: "x",
			source: "user" as const,
			enabled: true,
			exposure: "deferred" as const,
			tools: [],
		};
		expect(
			transportSummary({ ...base, transport: { kind: "stdio", command: "npx", args: ["-y", "pkg"] } }),
		).toBe("npx -y pkg");
		expect(transportSummary({ ...base, transport: { kind: "url", url: "https://a.example/mcp" } })).toBe(
			"https://a.example/mcp",
		);
		expect(transportSummary({ ...base, transport: { kind: "unknown" } })).toBe("");
	});
});

describe("McpPanel 初始态渲染冒烟", () => {
	beforeEach(() => {
		// Vitest 默认 classic JSX；生产构建由 React 插件使用 automatic JSX（同 localized-presentation.test.ts）
		vi.stubGlobal("React", React);
	});

	it("空配置初始态能渲染（说明文案 + 重连引导），不抛错", async () => {
		const { McpPanel } = await import("./McpPanel");
		const html = renderToStaticMarkup(createElement(McpPanel));
		expect(html).toContain("官方内置 mcp 扩展负责连接");
		expect(html).toContain("重连");
		expect(html).toContain("添加服务器");
	});
});
