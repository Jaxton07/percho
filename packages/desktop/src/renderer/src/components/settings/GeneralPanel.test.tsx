// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({
	codemodeEnabled: true as boolean | null,
	codemodeOnly: false as boolean | null,
	codemodeSaving: false,
	channelWatchEnabled: true,
	setCodemodeEnabled: vi.fn(),
	setCodemodeOnly: vi.fn(),
	setChannelWatchEnabled: vi.fn(),
}));
vi.mock("../../stores/settings", () => ({
	useSettingsStore: (select: (state: typeof settings) => unknown) => select(settings),
}));
vi.mock("./TaskNotificationSettings", () => ({ TaskNotificationSettings: () => null }));
vi.mock("./CacheWarmingSettings", () => ({ CacheWarmingSettings: () => null }));

import { useI18nStore } from "../../i18n";
import { GeneralPanel } from "./GeneralPanel";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
	vi.clearAllMocks();
	Object.assign(settings, { codemodeEnabled: true, codemodeOnly: false, codemodeSaving: false });
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	useI18nStore.setState({ language: "zh" });
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(() => root.unmount());
	host.remove();
	vi.unstubAllGlobals();
});
async function render() {
	await act(async () => root.render(<GeneralPanel />));
	return host.querySelectorAll<HTMLButtonElement>('[role="switch"]');
}
it("独占模式默认关闭，可以保存；中英文名称一致", async () => {
	const switches = await render();
	expect(host.textContent).toContain("Code Mode 独占模式");
	expect(switches[1].getAttribute("aria-checked")).toBe("false");
	expect(switches[1].disabled).toBe(false);
	await act(async () => switches[1].click());
	expect(settings.setCodemodeOnly).toHaveBeenCalledWith(true);
	await act(async () => useI18nStore.setState({ language: "en" }));
	expect(host.textContent).toContain("Code Mode only");
});
it.each([false, null])("总开关关闭或未加载时不能操作独占模式：%s", async (enabled) => {
	settings.codemodeEnabled = enabled;
	settings.codemodeOnly = true;
	const switches = await render();
	expect(switches[1].disabled).toBe(true);
	expect(switches[1].getAttribute("aria-checked")).toBe("true");
	await act(async () => switches[1].click());
	expect(settings.setCodemodeOnly).not.toHaveBeenCalled();
});
it("保存期间两个开关都禁用，避免交错写入", async () => {
	settings.codemodeSaving = true;
	const switches = await render();
	expect(switches[0].disabled).toBe(true);
	expect(switches[1].disabled).toBe(true);
});
