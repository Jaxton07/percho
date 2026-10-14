import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	windows: [] as Array<{ isDestroyed: () => boolean; webContents: { send: ReturnType<typeof vi.fn> } }>,
}));
vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => state.windows } }));

import { sendToRenderer } from "./send";

beforeEach(() => {
	state.windows = [];
});
describe("renderer event send leaf", () => {
	it("uses exactly the first window and forwards the original channel/payload without cloning", () => {
		const first = { isDestroyed: () => false, webContents: { send: vi.fn() } };
		const second = { isDestroyed: () => false, webContents: { send: vi.fn() } };
		state.windows = [first, second];
		const payload = { sessionId: "s1", event: { type: "agent_end" } };
		expect(sendToRenderer("pi:event", payload)).toBeUndefined();
		expect(first.webContents.send).toHaveBeenCalledOnce();
		expect(first.webContents.send).toHaveBeenCalledWith("pi:event", payload);
		expect(first.webContents.send.mock.calls[0]?.[1]).toBe(payload);
		expect(second.webContents.send).not.toHaveBeenCalled();
	});
	it("no window is a no-op; a destroyed first window does not fall through to another window", () => {
		expect(sendToRenderer("channel", undefined)).toBeUndefined();
		const destroyed = { isDestroyed: () => true, webContents: { send: vi.fn() } };
		const second = { isDestroyed: () => false, webContents: { send: vi.fn() } };
		state.windows = [destroyed, second];
		expect(sendToRenderer("channel", null)).toBeUndefined();
		expect(destroyed.webContents.send).not.toHaveBeenCalled();
		expect(second.webContents.send).not.toHaveBeenCalled();
	});
});
