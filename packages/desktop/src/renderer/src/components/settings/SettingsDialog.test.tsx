// @vitest-environment happy-dom
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("../../i18n", () => ({ useT: () => (key: string) => key }));
vi.mock("./GeneralPanel", () => ({ GeneralPanel: () => <div>general content</div> }));
vi.mock("./AppearancePanel", () => ({ AppearancePanel: () => null }));
vi.mock("./ArchivedChatsPanel", () => ({ ArchivedChatsPanel: () => null }));
vi.mock("./extensions/ExtensionsPanel", () => ({ ExtensionsPanel: () => null }));
vi.mock("./LanObserverPanel", () => ({ LanObserverPanel: () => null }));
vi.mock("./mcp/McpPanel", () => ({ McpPanel: () => <div>mcp content</div> }));
vi.mock("./providers/ProvidersPanel", () => ({ ProvidersPanel: () => null }));
vi.mock("./SkillsPanel", () => ({ SkillsPanel: () => null }));
vi.mock("./AboutPanel", () => ({ AboutPanel: () => null }));
vi.mock("../../lib/use-edge-fade", () => ({ useEdgeFade: () => {} }));

import { useRemoteConnectionStore } from "../../stores/remote-connection";
import { useLocalSettingsStore } from "../../stores/settings";
import { SettingsDialog } from "./SettingsDialog";

vi.stubGlobal("React", React);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

it("SSH 菜单挂在设置容器外，Escape 只关闭菜单", async () => {
	useRemoteConnectionStore.setState({
		status: { epoch: "test", generation: 1, revision: 1, state: "disconnected" },
		catalog: {
			epoch: "test",
			revision: 1,
			records: [{ connectionId: "a", alias: "host", revision: 1 }],
			lastSuccessfulConnectionId: null,
		},
	});
	useLocalSettingsStore.setState({ open: true, category: "remote" });
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => root.render(<SettingsDialog />));
	const trigger = container.querySelector<HTMLElement>('[aria-label="remote.ux.more host"]');
	await act(async () => trigger?.click());
	const settings = container.querySelector('[role="dialog"]');
	const menu = document.querySelector('[role="menu"]');
	expect(menu).not.toBeNull();
	expect(settings?.contains(menu)).toBe(false);
	await act(async () =>
		document.activeElement?.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
		),
	);
	expect(container.querySelector('[role="dialog"]')).not.toBeNull();
	expect(document.querySelector('[role="menu"]')).toBeNull();
	await act(async () => root.unmount());
	container.remove();
});

it("打开设置后可选择分类并用 Escape 关闭", async () => {
	useLocalSettingsStore.setState({ open: true, category: "general" });
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => root.render(<SettingsDialog />));
	expect(container.textContent).toContain("general content");
	const mcp = [...container.querySelectorAll("button")].find((button) =>
		button.textContent?.includes("settings.category.mcp"),
	);
	await act(async () => mcp?.click());
	expect(container.textContent).toContain("mcp content");
	expect(mcp?.getAttribute("aria-current")).toBe("page");
	const close = container.querySelector('button[aria-label="common.close"]');
	expect(close?.querySelector("svg")).not.toBeNull();
	expect(close?.hasAttribute("title")).toBe(false);
	await act(async () =>
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
	);
	expect(container.querySelector('[role="dialog"]')).toBeNull();
	await act(async () => root.unmount());
	container.remove();
});
