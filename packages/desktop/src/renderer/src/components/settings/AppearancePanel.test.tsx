// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const availability = vi.hoisted(() => ({ override: undefined as boolean | undefined }));
const api = vi.hoisted(() => ({ saveUiState: vi.fn(async () => {}) }));
vi.mock("../../lib/session-rail-availability", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../lib/session-rail-availability")>();
	return {
		get SESSION_RAIL_AVAILABLE() {
			return availability.override ?? actual.SESSION_RAIL_AVAILABLE;
		},
	};
});
vi.mock("../../api", () => ({ getPi: () => api }));
vi.mock("../../i18n", () => ({ useT: () => (key: string) => key }));
vi.mock("./UiPluginsSection", () => ({ UiPluginsSection: () => null }));

import { useSessionWorkspaceStore } from "../../stores/session-workspace";
import { useUiPreferencesStore } from "../../stores/ui-preferences";
import { AppearancePanel } from "./AppearancePanel";

const members = [{ file: "/session.jsonl", sessionId: "session" }];
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.clearAllMocks();
	availability.override = undefined;
	useUiPreferencesStore.setState({ barSessionsVisible: false, sessionRailEnabled: true });
	useSessionWorkspaceStore.setState({ members, activeFile: "/session.jsonl", recentFile: "/session.jsonl" });
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(async () => {
	await act(async () => root.unmount());
	host.remove();
	vi.unstubAllGlobals();
});

it("旧轨道偏好开启时仍隐藏入口，其他外观设置和工作区保持不变", async () => {
	const prefs = useUiPreferencesStore.getState();
	const workspace = useSessionWorkspaceStore.getState();
	await act(async () => root.render(<AppearancePanel />));

	expect(host.textContent).not.toContain("settings.sessionRail");
	expect(host.querySelectorAll('[role="switch"]')).toHaveLength(2);
	expect(host.textContent).toContain("settings.topBar");
	expect(host.textContent).toContain("settings.centerOrb");
	expect(host.querySelector('[aria-label="settings.theme"]')).not.toBeNull();
	for (const mode of ["Light", "Dark", "System"]) {
		expect(host.textContent).toContain(`settings.theme${mode}`);
	}
	expect(host.querySelector('[aria-label^="settings.fontSizeUi:"]')).not.toBeNull();
	expect(host.querySelector('[aria-label^="settings.fontSizeCode:"]')).not.toBeNull();
	expect(useUiPreferencesStore.getState()).toBe(prefs);
	expect(useUiPreferencesStore.getState().sessionRailEnabled).toBe(true);
	expect(useSessionWorkspaceStore.getState()).toBe(workspace);
	expect(api.saveUiState).not.toHaveBeenCalled();
});

it("恢复可用性后显示真实轨道开关并反映旧偏好", async () => {
	availability.override = true;
	await act(async () => root.render(<AppearancePanel />));
	const title = [...host.querySelectorAll("h3")].find(
		(element) => element.textContent === "settings.sessionRail",
	);
	const switchButton = title?.parentElement?.parentElement?.querySelector('[role="switch"]');
	expect(switchButton?.getAttribute("aria-checked")).toBe("true");
	expect(host.querySelectorAll('[role="switch"]')).toHaveLength(3);
	expect(useSessionWorkspaceStore.getState().members).toEqual(members);
	expect(api.saveUiState).not.toHaveBeenCalled();
});
