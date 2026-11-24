// @vitest-environment happy-dom
import type { PermissionMode } from "@percho/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { en } from "../../i18n/en";
import { zh } from "../../i18n/zh";
import { PermissionPicker } from "./PermissionPicker";

const state = vi.hoisted(() => ({
	activeSessionId: "session" as string | null,
	permissionModes: { session: "fullAccess" } as Record<string, PermissionMode>,
	newSessionDraft: { permissionMode: "default" as PermissionMode },
	setSessionPermissionMode: vi.fn(),
	setDraftPermissionMode: vi.fn(),
	permissionGateOff: false,
	loadPermissionGate: vi.fn(),
}));
vi.mock("../../stores/sessions", () => ({
	useSessionsStore: (selector: (value: typeof state) => unknown) => selector(state),
}));
vi.mock("../../stores/settings", () => ({
	useSettingsStore: (selector: (value: typeof state) => unknown) => selector(state),
}));
vi.mock("../../i18n", () => ({
	useT: () => (key: string) => zh.composer[key.replace("composer.", "") as keyof typeof zh.composer],
}));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.clearAllMocks();
	state.activeSessionId = "session";
	state.permissionModes.session = "fullAccess";
	state.newSessionDraft.permissionMode = "default";
	state.permissionGateOff = false;
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(() => root.unmount());
	host.remove();
	vi.unstubAllGlobals();
});
const render = () => act(() => root.render(<PermissionPicker />));
const trigger = () => {
	const button = host.querySelector<HTMLButtonElement>('button[aria-label="权限模式"]');
	if (!button) throw new Error("Missing permission trigger");
	return button;
};
const option = (index: number) => {
	const button = host.querySelectorAll<HTMLButtonElement>("[data-composer-overlay] button")[index];
	if (!button) throw new Error(`Missing permission option ${index}`);
	return button;
};

it.each([
	["default", "默认"],
	["fullAccess", "完全访问"],
] as const)("%s 模式的外部按钮仅显示灰色文字，无图标", async (mode, label) => {
	state.permissionModes.session = mode;
	await render();
	expect(trigger().textContent).toBe(label);
	expect(trigger().querySelector("svg")).toBeNull();
	expect(trigger().className).toContain("text-ink-dim");
	expect(trigger().className).not.toContain("text-warn");
});

it("弹窗保留图标和选中标记，完全访问的标题与外部文字一致", async () => {
	await render();
	await act(() => trigger().click());
	const options = host.querySelectorAll<HTMLButtonElement>("[data-composer-overlay] button");
	expect(options).toHaveLength(2);
	expect(option(0).querySelector("svg")).not.toBeNull();
	expect(option(1).querySelectorAll("svg")).toHaveLength(2);
	expect(option(1).querySelector("span > span")?.textContent).toBe(trigger().textContent);
	for (const messages of [zh, en]) {
		expect(messages.composer.permissionFullAccessTitle).toBe(messages.composer.permissionFullAccess);
	}
	await act(() => option(0).click());
	expect(state.setSessionPermissionMode).toHaveBeenCalledWith("session", "default");
	expect(host.querySelector("[data-composer-overlay]")).toBeNull();
});

it("草稿仍通过草稿权限入口选择完全访问", async () => {
	state.activeSessionId = null;
	await render();
	await act(() => trigger().click());
	await act(() => option(1).click());
	expect(state.setDraftPermissionMode).toHaveBeenCalledWith("fullAccess");
	expect(state.setSessionPermissionMode).not.toHaveBeenCalled();
});

it("权限门控关闭时保持禁用，不能打开弹窗", async () => {
	state.permissionGateOff = true;
	await render();
	expect(trigger().disabled).toBe(true);
	await act(() => trigger().click());
	expect(host.querySelector("[data-composer-overlay]")).toBeNull();
});
