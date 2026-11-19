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
		mcpReconnect: vi.fn().mockResolvedValue(undefined),
		mcpConfigUpsert: vi.fn(),
	},
}));
vi.mock("../../../environment-api", () => ({ getExecutionApi: () => fixture.api }));
vi.mock("../../../stores/sessions", () => ({
	useSessionsStore: (select: (s: object) => unknown) => select({ activeSessionId: "s", cwd: "/a" }),
}));
vi.mock("../../../lib/active-cwd", () => ({ selectActiveCwd: () => "/a" }));
vi.mock("../../../stores/transcript", () => ({
	useTranscriptStore: (select: (s: object) => unknown) => select({}),
	selectTranscript: () => ({ phase: "streaming" }),
}));
vi.mock("../../../i18n", () => ({
	useT: () => (key: string, args?: { count?: number }) =>
		`${key}${args?.count === undefined ? "" : ` ${args.count}`}`,
}));

import { useMcpStore } from "../../../stores/mcp";
import { McpPanel } from "./McpPanel";

it("保存启用后重开仍提示重启，实时停用不能重连或再次启用", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const server = {
		name: "disabled-server",
		source: "user",
		transport: { kind: "unknown" },
		enabled: false,
		exposure: "deferred",
		tools: [],
	};
	const runtime = {
		epoch: "disabled",
		revision: 1,
		instances: [
			{
				instanceId: "i-disabled",
				sessionId: "s",
				cwd: "/a",
				available: true,
				errors: [],
				servers: [{ name: server.name, source: "/global", state: "disabled", tools: [] }],
			},
		],
	};
	const base = {
		global: [server],
		project: [],
		errors: [],
		projectTrusted: true,
		globalPath: "/global",
		contextCwd: "/a",
		runtime,
	};
	const saved = { ...base, restartRequired: true, global: [{ ...server, enabled: true }] };
	fixture.api.mcpConfigList.mockResolvedValue(base);
	fixture.api.mcpConfigUpsert.mockResolvedValue({ config: saved });
	fixture.api.onMcpServersChanged.mockReturnValue(() => {});
	const host = document.createElement("div");
	const root = createRoot(host);
	try {
		await act(async () => root.render(<McpPanel />));
		await act(async () =>
			[...host.querySelectorAll("button")].find((b) => b.textContent === "settings.mcp.enable")?.click(),
		);
		expect(host.textContent).toContain("settings.mcp.restartRequired");
		expect(host.textContent).toContain("settings.mcp.waitingForRestart");
		expect(host.textContent).not.toContain("settings.mcp.enable");
		expect(
			[...host.querySelectorAll("button")].find((b) => b.textContent === "settings.mcp.reconnect")?.disabled,
		).toBe(true);
		await act(() => root.unmount());
		fixture.api.mcpConfigList.mockResolvedValue(saved);
		const reopened = createRoot(host);
		await act(async () => reopened.render(<McpPanel />));
		expect(host.textContent).toContain("settings.mcp.restartRequired");
		await act(() => reopened.unmount());
		fixture.api.mcpConfigList.mockResolvedValue({ ...base, restartRequired: false });
		await act(async () => useMcpStore.getState().load("/a", "s"));
		expect(useMcpStore.getState().restartRequired).toBe(false);
	} finally {
		vi.unstubAllGlobals();
	}
});

it("保存停用配置后，当前仍连接的服务器依然可以重连", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	useMcpStore.setState({ selectedInstanceId: undefined });
	fixture.api.mcpConfigList.mockResolvedValue({
		global: [
			{
				name: "still-connected",
				source: "user",
				transport: { kind: "unknown" },
				enabled: false,
				exposure: "direct",
				tools: [],
			},
		],
		project: [],
		errors: [],
		projectTrusted: true,
		globalPath: "/global",
		contextCwd: "/a",
		restartRequired: true,
		runtime: {
			epoch: "disabled-config-live-connection",
			revision: 1,
			instances: [
				{
					instanceId: "disable-pending",
					sessionId: "s",
					cwd: "/a",
					available: true,
					errors: [],
					servers: [{ name: "still-connected", source: "/global", state: "connected", tools: [] }],
				},
			],
		},
	});
	fixture.api.mcpReconnect.mockResolvedValue(undefined);
	const host = document.createElement("div");
	const root = createRoot(host);
	try {
		await act(async () => root.render(<McpPanel />));
		const reconnect = [...host.querySelectorAll("button")].find(
			(button) => button.textContent === "settings.mcp.reconnect",
		);
		expect(reconnect).toBeDefined();
		expect(reconnect?.disabled).toBe(false);
		await act(async () => reconnect?.click());
		expect(fixture.api.mcpReconnect).toHaveBeenLastCalledWith({
			instanceId: "disable-pending",
			name: "still-connected",
		});
		expect(host.textContent).toContain("settings.mcp.restartRequired");
	} finally {
		await act(() => root.unmount());
		vi.unstubAllGlobals();
	}
});

it("同名覆盖配置只在实际生效行显示重连加载和错误", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	useMcpStore.setState({ selectedInstanceId: undefined });
	fixture.api.mcpConfigList.mockResolvedValue({
		global: [
			{
				name: "same-name",
				source: "user",
				transport: { kind: "unknown" },
				enabled: true,
				exposure: "direct",
				tools: [],
			},
		],
		project: [
			{
				name: "same-name",
				source: "project",
				transport: { kind: "unknown" },
				enabled: true,
				exposure: "direct",
				tools: [],
			},
		],
		errors: [],
		projectTrusted: true,
		globalPath: "/global",
		projectPath: "/a/.pi/mcp.json",
		contextCwd: "/a",
		runtime: {
			epoch: "overridden-row-actions",
			revision: 1,
			instances: [
				{
					instanceId: "override-owner",
					sessionId: "s",
					cwd: "/a",
					available: true,
					errors: [],
					servers: [
						{
							name: "same-name",
							source: "/global",
							override: "/a/.pi/mcp.json",
							state: "connected",
							tools: [],
						},
					],
				},
			],
		},
	});
	let rejectPending: (error: Error) => void = () => {};
	fixture.api.mcpReconnect.mockReturnValueOnce(
		new Promise<void>((_, reject) => {
			rejectPending = reject;
		}),
	);
	const host = document.createElement("div");
	const root = createRoot(host);
	try {
		await act(async () => root.render(<McpPanel />));
		const rows = host.querySelectorAll<HTMLElement>('[class~="group/row"]');
		const globalRow = rows[0];
		const projectRow = rows[1];
		if (!globalRow || !projectRow) throw new Error("Missing overridden server rows");
		const button = [...projectRow.querySelectorAll("button")].find(
			(item) => item.textContent === "settings.mcp.reconnect",
		);
		await act(async () => button?.click());
		expect(fixture.api.mcpReconnect).toHaveBeenLastCalledWith({
			instanceId: "override-owner",
			name: "same-name",
		});
		expect(projectRow.textContent).toContain("settings.mcp.reconnecting");
		expect(globalRow.textContent).not.toContain("settings.mcp.reconnecting");
		await act(async () => rejectPending(new Error("project-row-only-error")));
		expect(projectRow.textContent).toContain("project-row-only-error");
		expect(globalRow.textContent).not.toContain("project-row-only-error");
	} finally {
		await act(async () => rejectPending(new Error("fixture cleanup")));
		await act(() => root.unmount());
		vi.unstubAllGlobals();
	}
});

it("手写的不支持配置仍展示服务器及 SDK 诊断", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	fixture.api.mcpConfigList.mockResolvedValue({
		global: [
			{
				name: "legacy",
				source: "user",
				transport: { kind: "stdio", command: "node" },
				enabled: true,
				exposure: "codemode",
				tools: [],
			},
		],
		project: [],
		errors: ['global: server "legacy": exposure must be one of "codemode", "deferred", "direct", "hidden"'],
		projectTrusted: true,
		globalPath: "/global",
		contextCwd: "/a",
	});
	fixture.api.onMcpServersChanged.mockReturnValue(() => {});
	const host = document.createElement("div");
	const root = createRoot(host);
	try {
		await act(async () => root.render(<McpPanel />));
		expect(host.textContent).toContain("legacy");
		expect(host.textContent).toContain('server "legacy": exposure must be one of');
	} finally {
		await act(() => root.unmount());
		vi.unstubAllGlobals();
	}
});

it("真实面板接收事件后清空错误及工具，并显示零工具已连接", async () => {
	useMcpStore.setState({ selectedInstanceId: undefined });
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
		let rejectReconnect!: (error: Error) => void;
		fixture.api.mcpReconnect.mockReturnValueOnce(
			new Promise<void>((_, reject) => {
				rejectReconnect = reject;
			}),
		);
		const reconnect = [...host.querySelectorAll("button")].find(
			(button) => button.textContent === "settings.mcp.reconnect",
		);
		expect(reconnect?.disabled).toBe(false);
		await act(async () => reconnect?.click());
		expect(fixture.api.mcpReconnect).toHaveBeenCalledWith({ instanceId: "i", name: "my-server" });
		expect(reconnect?.disabled).toBe(true);
		await act(async () => rejectReconnect(new Error("reconnect failed")));
		expect(host.textContent).toContain("reconnect failed");
		expect(reconnect?.disabled).toBe(false);
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

it("切换实例后旧重连的加载和错误不落到新实例", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	useMcpStore.setState({ selectedInstanceId: undefined });
	const instances: McpRuntimeInventory["instances"] = ["first", "second"].map((id, index) => ({
		instanceId: id,
		sessionId: index === 0 ? "s" : "other-session",
		cwd: "/a",
		available: true,
		errors: [],
		servers: [{ name: "same-server", source: "/global", state: "connected", tools: [] }],
	}));
	fixture.api.mcpConfigList.mockResolvedValue({
		global: [
			{
				name: "same-server",
				source: "user",
				transport: { kind: "unknown" },
				enabled: true,
				exposure: "direct",
				tools: [],
			},
		],
		project: [],
		errors: [],
		projectTrusted: true,
		globalPath: "/global",
		contextCwd: "/a",
		runtime: { epoch: "row-reconnect-switch", revision: 1, instances },
	});
	let rejectPending: (error: Error) => void = () => {};
	fixture.api.mcpReconnect.mockClear();
	fixture.api.mcpReconnect.mockReturnValueOnce(
		new Promise<void>((_, reject) => {
			rejectPending = reject;
		}),
	);
	const host = document.createElement("div");
	const root = createRoot(host);
	try {
		await act(async () => root.render(<McpPanel />));
		const button = () =>
			[...host.querySelectorAll("button")].find((item) => item.textContent === "settings.mcp.reconnect");
		await act(async () => button()?.click());
		expect(fixture.api.mcpReconnect).toHaveBeenLastCalledWith({ instanceId: "first", name: "same-server" });
		const selection = host.querySelector("select");
		if (!selection) throw new Error("Missing instance picker");
		await act(async () => {
			selection.value = "second";
			selection.dispatchEvent(new Event("change", { bubbles: true }));
		});
		expect(button()?.disabled).toBe(false);
		await act(async () => {
			selection.value = "first";
			selection.dispatchEvent(new Event("change", { bubbles: true }));
		});
		const pendingButton = [...host.querySelectorAll("button")].find(
			(item) => item.textContent === "settings.mcp.reconnecting",
		);
		expect(pendingButton?.disabled).toBe(true);
		await act(async () => pendingButton?.click());
		expect(fixture.api.mcpReconnect).toHaveBeenCalledTimes(1);
		await act(async () => rejectPending(new Error("old-instance-error")));
		expect(host.textContent).toContain("old-instance-error");
		await act(async () => {
			selection.value = "second";
			selection.dispatchEvent(new Event("change", { bubbles: true }));
		});
		expect(host.textContent).not.toContain("old-instance-error");
		expect(button()?.disabled).toBe(false);
	} finally {
		await act(async () => rejectPending(new Error("fixture cleanup")));
		await act(() => root.unmount());
		vi.unstubAllGlobals();
	}
});
