import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
	vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
	vi.stubGlobal("navigator", { language: "zh-CN" });
});
vi.mock("../../../api", () => ({ getPi: () => ({ onMcpServersChanged: () => () => {} }) }));

import { useMcpStore } from "../../../stores/mcp";
import { McpPanel } from "./McpPanel";

/**
 * SSR 固定读 Zustand **初始**快照（zustand v5 的 server snapshot 不跟随 setState），
 * 所以这份只覆盖「初始态能渲染、不炸」；带数据的呈现由 `pure.test.ts` 的纯函数矩阵 + 真机 GUI 验收覆盖。
 */
describe("McpPanel 初始态渲染冒烟", () => {
	beforeEach(() => {
		vi.stubGlobal("React", React);
		useMcpStore.setState({ config: null, loading: false, status: {}, lastReload: null });
	});

	it("空态可渲染：标题 + 添加按钮 + 空态说明", async () => {
		const html = renderToStaticMarkup(createElement(McpPanel));
		expect(html).toContain("添加服务器");
		expect(html).toContain("MCP");
	});
});
