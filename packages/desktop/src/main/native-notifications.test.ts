import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { isPackaged: false }, Notification: {} }));

import { NativeNotifications } from "./native-notifications";

function setup() {
	const events = new EventEmitter();
	const close = vi.fn(() => events.emit("close"));
	const show = vi.fn(() => events.emit("show"));
	const create = vi.fn(() => Object.assign(events, { close, show }));
	const adapter = new NativeNotifications(() => true, create);
	return { adapter, events, create, close, show };
}
describe("native notification submission", () => {
	it.each(["close", "click"] as const)("releases a displayed notification after %s", async (event) => {
		const { adapter, events, close } = setup();
		const clicked = vi.fn();
		await adapter.send("completed", clicked);
		events.emit(event);
		adapter.close();
		expect(close).not.toHaveBeenCalled();
		expect(clicked).toHaveBeenCalledTimes(event === "click" ? 1 : 0);
	});
	it("releases an object if the native show call throws", async () => {
		const { adapter, show, close } = setup();
		show.mockImplementation(() => {
			throw new Error("fixture show failure");
		});
		expect(await adapter.send("test")).toBe("failed");
		adapter.close();
		expect(close).not.toHaveBeenCalled();
	});
	it("does not let a late disk restore override a new user preference", async () => {
		const { adapter } = setup();
		let finish: (enabled: boolean) => void = () => {};
		adapter.restoreEnabled(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		adapter.setEnabled(false);
		finish(true);
		await adapter.ready;
		expect(adapter.enabled).toBe(false);
	});
	it("sends fixed localized copy and permits an explicit test while disabled", async () => {
		const { adapter, create } = setup();
		adapter.setEnabled(false);
		adapter.setLanguage("zh");
		expect(await adapter.send("test")).toBe("submitted");
		expect(create).toHaveBeenCalledWith("这是一条测试通知");
		adapter.close();
	});
	it("does not create a notice on unsupported systems; failures remain non-blocking", async () => {
		const create = vi.fn();
		expect(await new NativeNotifications(() => false, create).send("test")).toBe("unsupported");
		expect(create).not.toHaveBeenCalled();
		expect(
			await new NativeNotifications(
				() => true,
				() => {
					throw new Error("system denied");
				},
			).send("test"),
		).toBe("failed");
	});
	it("invalidates old click targets across disable/re-enable and closes owned notices", async () => {
		const { adapter, events, close } = setup();
		const clicked = vi.fn();
		await adapter.send("completed", clicked);
		adapter.setEnabled(false);
		adapter.setEnabled(true);
		events.emit("click");
		expect(clicked).not.toHaveBeenCalled();
		expect(close).toHaveBeenCalledOnce();
	});
	it("distinguishes a reported failure and releases it", async () => {
		const { adapter, events, show, close } = setup();
		show.mockImplementation(() => events.emit("failed"));
		expect(await adapter.send("test")).toBe("failed");
		adapter.close();
		expect(close).not.toHaveBeenCalled();
		expect(() => adapter.setLanguage("xx")).toThrow("Unsupported");
	});
});
