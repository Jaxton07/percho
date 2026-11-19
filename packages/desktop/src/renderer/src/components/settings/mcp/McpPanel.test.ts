// @vitest-environment happy-dom
import { environmentEntityKey } from "@percho/shared";
import * as React from "react";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
	vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
	Object.defineProperty(navigator, "language", { value: "zh-CN", configurable: true });
});
vi.mock("../../../api", () => ({ getPi: () => ({ onMcpServersChanged: () => () => {} }) }));
const execution = vi.hoisted(() => ({ mcpConfigList: vi.fn(), onMcpServersChanged: vi.fn(() => () => {}) }));
vi.mock("../../../environment-api", () => ({ getExecutionApi: () => execution }));

import { EnvironmentContext } from "../../../environment-context";
import { useMcpStore } from "../../../stores/mcp";
import { useSessionsStore } from "../../../stores/sessions";
import { McpPanel } from "./McpPanel";

/**
 * SSR 固定读 Zustand **初始**快照（zustand v5 的 server snapshot 不跟随 setState），
 * 所以这份只覆盖「初始态能渲染、不炸」；带数据的呈现由 `pure.test.ts` 的纯函数矩阵 + 真机 GUI 验收覆盖。
 */
describe("McpPanel 初始态渲染冒烟", () => {
	beforeEach(() => {
		vi.stubGlobal("React", React);
		useMcpStore.setState({
			config: null,
			loading: false,
			restartRequired: false,
			selectedInstanceId: undefined,
		});
	});

	it("选定远端环境只查询归属项目字面路径，不回落其他环境", async () => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		const remote = { kind: "ssh" as const, connectionId: "panel-test", environmentId: "remote" };
		const sessionId = environmentEntityKey(remote, "session");
		const cwd = environmentEntityKey(remote, "/remote/project");
		execution.mcpConfigList.mockResolvedValue({
			global: [],
			project: [],
			errors: [],
			projectTrusted: true,
			globalPath: "/global",
			contextCwd: "/remote/project",
		});
		useSessionsStore.setState({ activeSessionId: sessionId, sessions: [], cwd });
		const host = document.createElement("div");
		const root = createRoot(host);
		await React.act(async () =>
			root.render(createElement(EnvironmentContext.Provider, { value: remote }, createElement(McpPanel))),
		);
		expect(execution.mcpConfigList).toHaveBeenLastCalledWith({ cwd: "/remote/project" });
		await React.act(async () =>
			useSessionsStore.setState({ activeSessionId: "local-session", cwd: "/local/project" }),
		);
		expect(execution.mcpConfigList).toHaveBeenLastCalledWith({ cwd: undefined });
		await React.act(async () => root.unmount());
	});

	it("空态可渲染：标题 + 添加按钮 + 空态说明", async () => {
		const html = renderToStaticMarkup(createElement(McpPanel));
		expect(html).toContain("添加服务器");
		expect(html).toContain("MCP");
	});
});
