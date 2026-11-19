// @vitest-environment happy-dom
import type { McpServerView } from "@percho/shared";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("../../../stores/mcp", () => ({
	useMcpStore: () => ({
		config: undefined,
		reconnectActions: {},
		upsert: vi.fn(),
		remove: vi.fn(),
		reconnect: vi.fn(),
		login: vi.fn(),
	}),
	mcpActionKey: (instance: string, name: string) => `${instance}:${name}`,
}));
vi.mock("../../../i18n", () => ({
	useT: () => (key: string, args?: { count?: number; name?: string }) =>
		`${key}${args?.count === undefined ? "" : ` ${args.count}`}${args?.name === undefined ? "" : ` ${args.name}`}`,
}));

import { ServerRow } from "./ServerRow";

it("默认紧凑显示，名称打开原服务器，工具详情保留读写标记", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const server: McpServerView = {
		name: "example",
		source: "project",
		state: "connected",
		enabled: true,
		transport: { kind: "stdio", command: "/private/command", args: ["--secret-path"] },
		description: "description metadata",
		exposure: "deferred",
		toolExposure: { read: "direct" },
		tools: [
			{ name: "read", readOnly: true },
			{ name: "write", readOnly: false },
		],
	};
	const onEdit = vi.fn();
	const host = document.createElement("div");
	const root = createRoot(host);
	try {
		await act(() => root.render(<ServerRow server={server} cwd="/project" onEdit={onEdit} />));
		for (const hidden of [
			"/private/command",
			"--secret-path",
			"description metadata",
			"deferred",
			"settings.mcp.transportStdio",
			"settings.mcp.toolsReadOnly",
		]) {
			expect(host.textContent).not.toContain(hidden);
		}
		const name = host.querySelector<HTMLButtonElement>(
			'button[aria-label="settings.mcp.viewServer example"]',
		);
		expect(name?.textContent).toBe("example");
		await act(() => name?.click());
		expect(onEdit).toHaveBeenCalledWith(server);
		const tools = [...host.querySelectorAll("button")].find(
			(button) => button.textContent === "settings.mcp.toolsCount 2",
		);
		expect(tools).toBeDefined();
		await act(() => tools?.click());
		expect(host.textContent).toContain("settings.mcp.toolsReadOnly 1");
		expect(host.textContent).toContain("settings.mcp.toolReadOnly");
		expect(host.textContent).toContain("settings.mcp.toolWrite");
	} finally {
		await act(() => root.unmount());
		vi.unstubAllGlobals();
	}
});
