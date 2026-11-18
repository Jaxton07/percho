// @vitest-environment happy-dom
import type { McpRuntimeInventory } from "@percho/shared";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
	callback: undefined as ((payload: McpRuntimeInventory) => void) | undefined,
	api: {
		mcpConfigList: vi.fn(),
		onMcpServersChanged: vi.fn(),
		mcpLogin: vi.fn().mockResolvedValue(undefined),
	},
}));
vi.mock("../../../environment-api", () => ({ getExecutionApi: () => fixture.api }));
vi.mock("../../../stores/sessions", () => ({
	useSessionsStore: (select: (s: object) => unknown) => select({ activeSessionId: null, cwd: "/a" }),
}));
vi.mock("../../../lib/active-cwd", () => ({ selectActiveCwd: () => "/a" }));
vi.mock("../../../stores/transcript", () => ({
	useTranscriptStore: (select: (s: object) => unknown) => select({}),
	selectTranscript: () => ({ phase: "idle" }),
}));
vi.mock("../../../i18n", () => ({
	useT: () => (key: string, args?: { count?: number }) =>
		`${key}${args?.count === undefined ? "" : ` ${args.count}`}`,
}));

import { McpPanel } from "./McpPanel";

it("真实面板接收事件后清空错误及工具，并显示零工具已连接", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const instance = {
		instanceId: "i",
		sessionId: "s",
		cwd: "/a",
		available: true,
		errors: [],
		servers: [
			{
				name: "my-server",
				source: "/global",
				state: "failed" as const,
				tools: [{ name: "mcp__my_server__tool" }],
				error: "old error",
			},
		],
	};
	fixture.api.mcpConfigList.mockResolvedValue({
		global: [
			{
				name: "my-server",
				source: "user",
				transport: { kind: "unknown" },
				enabled: true,
				exposure: "deferred",
				tools: [],
			},
		],
		project: [],
		errors: [],
		projectTrusted: true,
		globalPath: "/global",
		contextCwd: "/a",
		runtime: { epoch: "e", revision: 1, instances: [instance] },
	});
	fixture.api.onMcpServersChanged.mockImplementation((callback) => {
		fixture.callback = callback;
		return () => {};
	});
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	try {
		await act(async () => root.render(<McpPanel />));
		expect(host.textContent).toContain("settings.mcp.state.failed");
		expect(host.textContent).toContain("settings.mcp.toolsCount 1");
		await act(async () =>
			fixture.callback?.({
				epoch: "e",
				revision: 2,
				instances: [
					{
						...instance,
						servers: [{ ...instance.servers[0]!, state: "connected", tools: [], error: undefined }],
					},
				],
			}),
		);
		expect(host.textContent).toContain("settings.mcp.connectedZero");
		expect(host.textContent).not.toContain("settings.mcp.state.failed");
		expect(host.textContent).not.toContain("settings.mcp.toolsCount 1");
		await act(async () =>
			fixture.callback?.({
				epoch: "e",
				revision: 3,
				instances: [
					{
						...instance,
						servers: [{ name: "my-server", source: "/global", state: "needs-auth", tools: [] }],
					},
				],
			}),
		);
		const login = [...host.querySelectorAll("button")].find(
			(button) => button.textContent === "settings.mcp.login",
		);
		expect(login).toBeDefined();
		await act(async () => login?.click());
		expect(fixture.api.mcpLogin).toHaveBeenCalledWith({ instanceId: "i", name: "my-server" });
		fixture.api.mcpLogin.mockRejectedValueOnce(new Error("login failed"));
		await act(async () =>
			[...host.querySelectorAll("button")]
				.find((button) => button.textContent === "settings.mcp.login")
				?.click(),
		);
		expect(host.textContent).toContain("login failed");
		expect(host.textContent).toContain("settings.mcp.login");
	} finally {
		await act(() => root.unmount());
		host.remove();
		vi.unstubAllGlobals();
	}
});
