// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ test: vi.fn(), save: vi.fn(async () => {}) }));
vi.mock("../../api", () => ({
	getPi: () => ({ testTaskNotification: fixture.test, saveUiState: fixture.save }),
}));

import { useI18nStore } from "../../i18n";
import { useUiPreferencesStore } from "../../stores/ui-preferences";
import { TaskNotificationSettings } from "./TaskNotificationSettings";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

const container = document.createElement("div");
document.body.append(container);
let root = createRoot(container);
afterEach(async () => {
	await act(async () => root.unmount());
	root = createRoot(container);
	vi.clearAllMocks();
});
describe("desktop notification settings", () => {
	it("allows an explicit test while disabled and reports unsupported honestly", async () => {
		useI18nStore.setState({ language: "zh" });
		useUiPreferencesStore.setState({ taskNotificationsEnabled: false });
		fixture.test.mockResolvedValue("unsupported");
		await act(async () => root.render(<TaskNotificationSettings />));
		const test = [...container.querySelectorAll("button")].find((x) => x.textContent === "发送测试通知");
		await act(async () => test?.click());
		expect(fixture.test).toHaveBeenCalledOnce();
		expect(container.querySelector('[role="status"]')?.textContent).toContain("不支持");
		expect(useUiPreferencesStore.getState().taskNotificationsEnabled).toBe(false);
		expect(fixture.save).not.toHaveBeenCalled();
	});
	it("does not claim visibility on submission and contains rejection failures", async () => {
		useI18nStore.setState({ language: "en" });
		fixture.test.mockResolvedValue("submitted");
		await act(async () => root.render(<TaskNotificationSettings />));
		const test = [...container.querySelectorAll("button")].find(
			(x) => x.textContent === "Send test notification",
		);
		await act(async () => test?.click());
		expect(container.textContent).toContain("Visibility depends");
		fixture.test.mockRejectedValue(new Error("private failure details"));
		await act(async () => test?.click());
		expect(container.textContent).toContain("Could not submit");
		expect(container.textContent).not.toContain("private failure details");
	});
});
