import { LOCAL_ENVIRONMENT, type SessionEvent, type SessionMeta } from "@percho/shared";
import { describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
	focused: true,
	visible: true,
	minimized: false,
	send: vi.fn(async (_kind: string, _clicked: () => void) => "submitted"),
	restore: vi.fn(),
	show: vi.fn(),
	focus: vi.fn(),
	deliver: vi.fn(),
}));
vi.mock("electron", () => ({
	app: {},
	BrowserWindow: {
		getAllWindows: () => [
			{
				isDestroyed: () => false,
				isFocused: () => fixture.focused,
				isVisible: () => fixture.visible,
				isMinimized: () => fixture.minimized,
				restore: fixture.restore,
				show: fixture.show,
				focus: fixture.focus,
				webContents: { send: fixture.deliver },
			},
		],
	},
}));
vi.mock("./native-notifications", () => ({
	nativeNotifications: { enabled: true, ready: Promise.resolve(), send: fixture.send },
}));

import {
	observeTaskNotification,
	TaskNotificationNavigation,
	taskNotificationNavigation,
} from "./task-notifications";

describe("native notification navigation readiness", () => {
	it("suppresses a focused task, submits hidden/minimized results and restores the clicked target", async () => {
		const run = (sessionId: string) => {
			for (const event of [
				{ type: "agent_start" },
				{ type: "turn_end", message: { role: "assistant", stopReason: "stop" } },
				{ type: "agent_end" },
				{ type: "agent_settled", aborted: false },
			])
				observeTaskNotification(
					LOCAL_ENVIRONMENT,
					{ sessionId, event: event as SessionEvent },
					() => ({ sessionId }) as SessionMeta,
				);
		};
		run("front");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(fixture.send).not.toHaveBeenCalled();
		fixture.visible = false;
		run("hidden");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(fixture.send).toHaveBeenCalledOnce();
		fixture.visible = true;
		fixture.minimized = true;
		run("minimized");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(fixture.send).toHaveBeenCalledTimes(2);
		taskNotificationNavigation.setReady(true);
		fixture.send.mock.calls.at(-1)?.[1]();
		expect(fixture.restore).toHaveBeenCalledOnce();
		expect(fixture.show).toHaveBeenCalledOnce();
		expect(fixture.focus).toHaveBeenCalledOnce();
		expect(fixture.deliver).toHaveBeenCalledWith(expect.any(String), {
			target: { environment: LOCAL_ENVIRONMENT, sessionId: "minimized", sessionFile: undefined },
			queued: false,
		});
		taskNotificationNavigation.clear();
	});
	it("delivers only the latest pre-ready click without waiting for target history", () => {
		const restore = vi.fn(),
			deliver = vi.fn();
		const navigation = new TaskNotificationNavigation(restore, deliver);
		const first = { environment: LOCAL_ENVIRONMENT, sessionId: "a" };
		const second = { environment: LOCAL_ENVIRONMENT, sessionId: "b" };
		navigation.click(first, () => true);
		navigation.click(second, () => true);
		expect(restore).toHaveBeenCalledTimes(2);
		expect(deliver).not.toHaveBeenCalled();
		navigation.setReady(true);
		expect(deliver).toHaveBeenCalledWith({ target: second, queued: true });
		navigation.setReady(true);
		expect(deliver).toHaveBeenCalledOnce();
	});
	it("revalidates a queued click and resets readiness on reload", () => {
		const deliver = vi.fn();
		const navigation = new TaskNotificationNavigation(vi.fn(), deliver);
		let valid = true;
		navigation.click({ environment: LOCAL_ENVIRONMENT, sessionId: "gone" }, () => valid);
		valid = false;
		navigation.setReady(true);
		expect(deliver).toHaveBeenCalledWith({ target: null, queued: true });
		navigation.setReady(false);
		deliver.mockClear();
		navigation.click({ environment: LOCAL_ENVIRONMENT, sessionId: "new" }, () => true);
		expect(deliver).not.toHaveBeenCalled();
		navigation.clear();
		navigation.setReady(true);
		expect(deliver).not.toHaveBeenCalled();
	});
});
