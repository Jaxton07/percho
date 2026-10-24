import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	windows: [] as Array<{ isDestroyed: () => boolean; webContents: { send: ReturnType<typeof vi.fn> } }>,
}));
vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => state.windows } }));

import { forward, sendToRenderer } from "./send";

beforeEach(() => {
	state.windows = [];
});
describe("renderer event send leaf", () => {
	it("preserves the source of execution events and rejects remote native events", () => {
		const window = { isDestroyed: () => false, webContents: { send: vi.fn() } };
		state.windows = [window];
		const remote = { kind: "ssh" as const, connectionId: "company", environmentId: "data" };
		const payload = {
			sessionId: "same-id",
			event: { type: "agent_end" as const, messages: [], willRetry: false },
		};
		sendToRenderer("pi:event", payload, remote);
		expect(window.webContents.send).toHaveBeenCalledExactlyOnceWith("pi:event", payload, remote);
		expect(() => sendToRenderer("app:quit-requested", undefined, remote)).toThrow("Desktop events");
		expect(window.webContents.send).toHaveBeenCalledTimes(1);
	});
	it("explicit source forward passes the same payload through the typed send leaf", () => {
		const window = { isDestroyed: () => false, webContents: { send: vi.fn() } };
		state.windows = [window];
		const payload = { kind: "config" as const };
		let emit: (value: typeof payload) => void = () => {
			throw new Error("source not bound");
		};
		forward((handler) => {
			emit = handler;
		}, "uiPlugins:event");
		emit(payload);
		expect(window.webContents.send).toHaveBeenCalledWith("uiPlugins:event", payload);
		expect(window.webContents.send.mock.calls[0]?.[1]).toBe(payload);
	});
	it("uses exactly the first window and forwards the original channel/payload without cloning", () => {
		const first = { isDestroyed: () => false, webContents: { send: vi.fn() } };
		const second = { isDestroyed: () => false, webContents: { send: vi.fn() } };
		state.windows = [first, second];
		const payload = { kind: "changed" as const, name: "demo" };
		expect(sendToRenderer("uiPlugins:event", payload)).toBeUndefined();
		expect(first.webContents.send).toHaveBeenCalledOnce();
		expect(first.webContents.send).toHaveBeenCalledWith("uiPlugins:event", payload);
		expect(first.webContents.send.mock.calls[0]?.[1]).toBe(payload);
		expect(second.webContents.send).not.toHaveBeenCalled();
	});
	it("no window is a no-op; a destroyed first window does not fall through to another window", () => {
		expect(sendToRenderer("app:quit-requested", undefined)).toBeUndefined();
		const destroyed = { isDestroyed: () => true, webContents: { send: vi.fn() } };
		const second = { isDestroyed: () => false, webContents: { send: vi.fn() } };
		state.windows = [destroyed, second];
		expect(sendToRenderer("app:quit-requested", undefined)).toBeUndefined();
		expect(destroyed.webContents.send).not.toHaveBeenCalled();
		expect(second.webContents.send).not.toHaveBeenCalled();
	});
});
