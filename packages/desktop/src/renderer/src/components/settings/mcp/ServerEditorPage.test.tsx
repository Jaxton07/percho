// @vitest-environment happy-dom
import { CHANNEL_TABLE, MCP_EXPOSURES, type McpServerView } from "@percho/shared";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ upsert: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../../stores/mcp", () => ({ useMcpStore: () => fixture }));
vi.mock("../../../i18n", () => ({ useT: () => (key: string) => key }));

import { ServerEditorPage } from "./ServerEditorPage";

const server: McpServerView = {
	name: "example",
	source: "user",
	transport: { kind: "stdio", command: "/bin/example", args: ["old"] },
	enabled: true,
	exposure: "deferred",
	tools: [],
};

it("清空已有参数时提交空数组，且不提供 SDK 不支持的档位", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	fixture.upsert.mockClear();
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	try {
		await act(async () => root.render(<ServerEditorPage server={server} projectTrusted onBack={() => {}} />));
		const args = host.querySelector<HTMLInputElement>("#mcp-args")!;
		await act(async () => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(args, "");
			args.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () =>
			[...host.querySelectorAll("button")].find((b) => b.textContent === "settings.mcp.save")!.click(),
		);
		expect(fixture.upsert).toHaveBeenCalledWith(expect.objectContaining({ args: [] }));
		expect(host.textContent).not.toContain("model-only");
	} finally {
		await act(() => root.unmount());
		host.remove();
		vi.unstubAllGlobals();
	}
});

it.each([
	["含空格和引号", ["hello world", '--literal="a b"']],
	["空字符串", [""]],
])("仅修改描述时保留原有%s参数边界", async (_label, originalArgs) => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	fixture.upsert.mockClear();
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	try {
		const existing = {
			...server,
			transport: { kind: "stdio" as const, command: "/bin/example", args: originalArgs },
		};
		await act(async () =>
			root.render(<ServerEditorPage server={existing} projectTrusted onBack={() => {}} />),
		);
		const description = host.querySelector<HTMLInputElement>("#mcp-desc")!;
		await act(async () => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(description, "changed");
			description.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () =>
			[...host.querySelectorAll("button")].find((b) => b.textContent === "settings.mcp.save")!.click(),
		);
		expect(fixture.upsert).toHaveBeenCalledWith(
			expect.objectContaining({ description: "changed", args: originalArgs }),
		);
	} finally {
		await act(() => root.unmount());
		host.remove();
		vi.unstubAllGlobals();
	}
});

it("原参数为空字符串时，真正编辑后清空会提交空数组", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	fixture.upsert.mockClear();
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	try {
		const existing = {
			...server,
			transport: { kind: "stdio" as const, command: "/bin/example", args: [""] },
		};
		await act(async () =>
			root.render(<ServerEditorPage server={existing} projectTrusted onBack={() => {}} />),
		);
		const args = host.querySelector<HTMLInputElement>("#mcp-args")!;
		for (const value of ["x", ""]) {
			await act(async () => {
				Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(args, value);
				args.dispatchEvent(new Event("input", { bubbles: true }));
			});
		}
		await act(async () =>
			[...host.querySelectorAll("button")].find((b) => b.textContent === "settings.mcp.save")!.click(),
		);
		expect(fixture.upsert).toHaveBeenCalledWith(expect.objectContaining({ args: [] }));
	} finally {
		await act(() => root.unmount());
		host.remove();
		vi.unstubAllGlobals();
	}
});

it("编辑参数后沿用空白分隔语义", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	fixture.upsert.mockClear();
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	try {
		await act(async () => root.render(<ServerEditorPage server={server} projectTrusted onBack={() => {}} />));
		const args = host.querySelector<HTMLInputElement>("#mcp-args")!;
		await act(async () => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
				args,
				'one "two three"',
			);
			args.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () =>
			[...host.querySelectorAll("button")].find((b) => b.textContent === "settings.mcp.save")!.click(),
		);
		expect(fixture.upsert).toHaveBeenCalledWith(expect.objectContaining({ args: ["one", '"two', 'three"'] }));
	} finally {
		await act(() => root.unmount());
		host.remove();
		vi.unstubAllGlobals();
	}
});

it("URL 切换到命令时不携带 URL 或继承参数", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	fixture.upsert.mockClear();
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	try {
		const existing = { ...server, transport: { kind: "url" as const, url: "https://example.com/mcp" } };
		await act(async () =>
			root.render(<ServerEditorPage server={existing} projectTrusted onBack={() => {}} />),
		);
		await act(async () =>
			[...host.querySelectorAll("button")]
				.find((b) => b.textContent === "settings.mcp.transportCommand")!
				.click(),
		);
		const command = host.querySelector<HTMLInputElement>("#mcp-command")!;
		await act(async () => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
				command,
				"/bin/example",
			);
			command.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () =>
			[...host.querySelectorAll("button")].find((b) => b.textContent === "settings.mcp.save")!.click(),
		);
		expect(fixture.upsert).toHaveBeenCalledWith(
			expect.objectContaining({ command: "/bin/example", args: [], url: undefined }),
		);
	} finally {
		await act(() => root.unmount());
		host.remove();
		vi.unstubAllGlobals();
	}
});

it("切换到 URL 时不发送原命令和参数", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	fixture.upsert.mockClear();
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	try {
		await act(async () => root.render(<ServerEditorPage server={server} projectTrusted onBack={() => {}} />));
		await act(async () =>
			[...host.querySelectorAll("button")]
				.find((b) => b.textContent === "settings.mcp.transportUrlOption")!
				.click(),
		);
		const url = host.querySelector<HTMLInputElement>("#mcp-url")!;
		await act(async () => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
				url,
				"https://example.com/mcp",
			);
			url.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () =>
			[...host.querySelectorAll("button")].find((b) => b.textContent === "settings.mcp.save")!.click(),
		);
		expect(fixture.upsert).toHaveBeenCalledWith(
			expect.objectContaining({ command: undefined, args: undefined, url: "https://example.com/mcp" }),
		);
	} finally {
		await act(() => root.unmount());
		host.remove();
		vi.unstubAllGlobals();
	}
});

it("已有不支持的档位不会被编辑器当成可选值或静默更改", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	fixture.upsert.mockClear();
	const host = document.createElement("div");
	const root = createRoot(host);
	try {
		const legacy = { ...server, exposure: "model-only" as McpServerView["exposure"] };
		await act(async () => root.render(<ServerEditorPage server={legacy} projectTrusted onBack={() => {}} />));
		expect(host.textContent).not.toContain("model-only");
		await act(async () =>
			[...host.querySelectorAll("button")].find((b) => b.textContent === "settings.mcp.save")!.click(),
		);
		expect(fixture.upsert).toHaveBeenCalledWith(expect.objectContaining({ exposure: undefined }));
	} finally {
		await act(() => root.unmount());
		vi.unstubAllGlobals();
	}
});

it("IPC 只接受 SDK 支持的档位", () => {
	for (const exposure of MCP_EXPOSURES)
		expect(() =>
			CHANNEL_TABLE.mcpConfigUpsert.validate({ scope: "user", name: "example", exposure }),
		).not.toThrow();
	expect(() =>
		CHANNEL_TABLE.mcpConfigUpsert.validate({ scope: "user", name: "example", exposure: "model-only" }),
	).toThrow();
});

it("项目覆盖保存不发送传输和描述字段", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	fixture.upsert.mockClear();
	const host = document.createElement("div");
	const root = createRoot(host);
	try {
		await act(async () =>
			root.render(
				<ServerEditorPage
					server={{ ...server, source: "project", isOverride: true }}
					cwd="/project"
					projectTrusted
					onBack={() => {}}
				/>,
			),
		);
		await act(async () =>
			[...host.querySelectorAll("button")].find((b) => b.textContent === "settings.mcp.save")!.click(),
		);
		expect(fixture.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				command: undefined,
				args: undefined,
				url: undefined,
				description: undefined,
				exposure: undefined,
			}),
		);
	} finally {
		await act(() => root.unmount());
		vi.unstubAllGlobals();
	}
});
