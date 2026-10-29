import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ templates: [] as Electron.MenuItemConstructorOptions[][] }));
vi.mock("electron", () => ({
	Menu: {
		buildFromTemplate: (template: Electron.MenuItemConstructorOptions[]) => {
			native.templates.push(template);
			return {
				items: template.map((item) => ({ label: item.role ?? item.label })),
				popup: vi.fn(),
				closePopup: vi.fn(),
			};
		},
	},
}));

import {
	attachComposerEditMenu,
	ComposerMenuBroker,
	cancelComposerEditMenu,
	showComposerEditMenu,
} from "./composer-edit-menu";

const context = () => ({
	x: 12,
	y: 30,
	frame: null,
	isEditable: true,
	editFlags: {
		canUndo: false,
		canRedo: false,
		canCut: true,
		canCopy: true,
		canPaste: true,
		canSelectAll: true,
		canDelete: true,
		canEditRichly: true,
	},
});
afterEach(() => vi.useRealTimers());
describe("composer native context ownership", () => {
	it("derives disabled edits from the native readonly context and invalidates actions on navigation", () => {
		native.templates = [];
		const contents = Object.assign(new EventEmitter(), {
			mainFrame: {},
			isDestroyed: () => false,
			cut: vi.fn(),
			copy: vi.fn(),
			paste: vi.fn(),
			selectAll: vi.fn(),
		});
		const window = { webContents: contents } as unknown as Electron.BrowserWindow;
		attachComposerEditMenu(window);
		const event = {
			sender: contents,
			senderFrame: contents.mainFrame,
		} as unknown as Electron.IpcMainInvokeEvent;
		// Ordinary document contexts alone cannot open the composer menu.
		contents.emit("context-menu", {}, { ...context(), frame: contents.mainFrame, isEditable: false });
		expect(native.templates).toHaveLength(0);
		showComposerEditMenu({ token: "readonly", x: 12, y: 30 }, event);
		const items = native.templates.at(-1) ?? [];
		expect(items.map((item) => item.enabled)).toEqual([false, true, false, true]);
		const copy = items[1]?.click as () => void;
		copy();
		expect(contents.copy).toHaveBeenCalledOnce();
		contents.emit("did-start-navigation");
		copy();
		expect(contents.copy).toHaveBeenCalledOnce();
		cancelComposerEditMenu({ token: "readonly" }, event);
		contents.emit("destroyed");
	});
	it("keeps a selected action valid when Cocoa closes the popup before click", () => {
		let valid = () => false;
		let closed = () => {};
		const broker = new ComposerMenuBroker((_context, check, onClosed) => {
			valid = check;
			closed = onClosed;
			return () => {};
		});
		broker.request({ token: "one", x: 12, y: 30 });
		broker.context(context());
		closed();
		expect(valid()).toBe(true);
		broker.context(context());
		expect(valid()).toBe(false);
		broker.cancel();
	});
	it.each([true, false])("pairs either arrival order without reusing native context (%s)", (nativeFirst) => {
		const show = vi.fn(() => vi.fn());
		const broker = new ComposerMenuBroker(show);
		const request = { token: "first", x: 12, y: 30 };
		if (nativeFirst) {
			broker.context(context());
			broker.request(request);
		} else {
			broker.request(request);
			broker.context(context());
		}
		expect(show).toHaveBeenCalledTimes(1);
		broker.cancel("first");
		broker.request({ ...request, token: "second" });
		expect(show).toHaveBeenCalledTimes(1);
		broker.cancel();
	});
	it("invalidates a captured action when switching editor and ignores an old cleanup", () => {
		let valid: () => boolean = () => false;
		const close = vi.fn();
		const broker = new ComposerMenuBroker((_context, check) => {
			valid = check;
			return close;
		});
		broker.request({ token: "one", x: 12, y: 30 });
		broker.context(context());
		const old = valid;
		broker.cancel("one");
		expect(old()).toBe(false);
		expect(close).toHaveBeenCalledTimes(1);
		broker.request({ token: "two", x: 12, y: 30 });
		broker.context(context());
		broker.cancel("one");
		expect(valid()).toBe(true);
		broker.cancel();
	});
	it("drops mismatched coordinates and expired unmatched events", () => {
		vi.useFakeTimers();
		const show = vi.fn(() => vi.fn());
		const broker = new ComposerMenuBroker(show);
		broker.context(context());
		broker.request({ token: "bad", x: 80, y: 30 });
		expect(show).not.toHaveBeenCalled();
		broker.context(context());
		vi.advanceTimersByTime(1001);
		broker.request({ token: "late", x: 12, y: 30 });
		expect(show).not.toHaveBeenCalled();
		broker.cancel();
	});
	it("rejects malformed requests and missing invoke provenance", () => {
		const broker = new ComposerMenuBroker(() => () => {});
		expect(() => broker.request({ token: "", x: 0, y: 0 })).toThrow("Invalid");
		expect(() => broker.request({ token: "a", x: Number.NaN, y: 0 })).toThrow("Invalid");
		expect(() => showComposerEditMenu({ token: "a", x: 0, y: 0 })).toThrow("source");
		const event = { sender: { isDestroyed: () => false, mainFrame: {} }, senderFrame: {} };
		expect(() =>
			showComposerEditMenu({ token: "a", x: 0, y: 0 }, event as Electron.IpcMainInvokeEvent),
		).toThrow("source");
		event.senderFrame = event.sender.mainFrame;
		expect(() =>
			showComposerEditMenu({ token: "a", x: 0, y: 0 }, event as Electron.IpcMainInvokeEvent),
		).toThrow("unavailable");
	});
});
