// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const save = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("../../api", () => ({ getPi: () => ({ saveUiState: save }) }));
vi.mock("../../i18n", () => ({ useT: () => (key: string) => key }));

import { useUiPreferencesStore } from "../../stores/ui-preferences";
import { ChatColumn } from "./ChatColumn";
import { ChatColumnResizeHandles } from "./ChatColumnResizeHandles";

let root: Root;
let host: HTMLDivElement;
let width: number;
let resize: () => void;
const captured = new WeakMap<Element, number>();
const childRender = vi.fn();
function Transcript() {
	childRender();
	return <p>Message</p>;
}
const intent = () => useUiPreferencesStore.getState().chatColumnWidth;
const handle = (side = "right") => {
	const element = host.querySelector<HTMLHRElement>(`[data-side="${side}"]`);
	if (!element) throw new Error(`Missing ${side} resize handle`);
	return element;
};

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal(
		"ResizeObserver",
		class {
			constructor(callback: () => void) {
				resize = callback;
			}
			observe() {}
			disconnect() {}
		},
	);
	vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => width);
	HTMLElement.prototype.setPointerCapture = function (id) {
		captured.set(this, id);
	};
	HTMLElement.prototype.hasPointerCapture = function (id) {
		return captured.get(this) === id;
	};
	HTMLElement.prototype.releasePointerCapture = function () {
		captured.delete(this);
	};
	useUiPreferencesStore.setState({ chatColumnWidth: 760 });
	save.mockClear();
	width = 1200;
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(async () => root.unmount());
	host.remove();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
async function mount(empty = false) {
	await act(async () => root.render(<ChatColumnResizeHandles empty={empty} />));
}
async function pointer(type: string, x: number, side = "right", buttons = 1, id = 1) {
	await act(() =>
		handle(side).dispatchEvent(
			new PointerEvent(type, {
				bubbles: true,
				pointerId: id,
				button: 0,
				buttons,
				clientX: x,
			}),
		),
	);
}
async function key(name: string, side = "right", shiftKey = false) {
	await act(() =>
		handle(side).dispatchEvent(
			new KeyboardEvent("keydown", {
				bubbles: true,
				cancelable: true,
				key: name,
				shiftKey,
			}),
		),
	);
}

describe("chat column resizing", () => {
	it.each([
		["right", 20],
		["left", -20],
	])("%s edge resizes symmetrically and saves only on release", async (side, delta) => {
		await mount();
		await pointer("pointerdown", 600, side);
		await pointer("pointermove", 600 + delta, side);
		expect(intent()).toBe(800);
		expect(save).not.toHaveBeenCalled();
		await pointer("pointerup", 600 + delta, side, 0);
		await pointer("lostpointercapture", 600 + delta, side, 0);
		expect(save).toHaveBeenCalledExactlyOnceWith({ state: { chatColumnWidth: 800 } });
		expect(document.body.style.cursor).toBe("");
	});
	it("limits deliberate resizing to the minimum and available container width", async () => {
		await mount();
		await pointer("pointerdown", 600);
		await pointer("pointermove", -100);
		expect(intent()).toBe(480);
		await pointer("pointermove", 3000);
		expect(intent()).toBe(1200);
	});
	it("keeps stored intent on window shrink and no-op click, but starts an intentional drag at the visible edge", async () => {
		useUiPreferencesStore.setState({ chatColumnWidth: 1100 });
		await mount();
		width = 700;
		await act(async () => resize());
		expect(intent()).toBe(1100);
		expect(handle().getAttribute("aria-valuenow")).toBe("700");
		await pointer("pointerdown", 650);
		await pointer("pointerup", 650, "right", 0);
		expect(intent()).toBe(1100);
		expect(save).not.toHaveBeenCalled();
		await pointer("pointerdown", 650);
		await pointer("pointermove", 640);
		expect(intent()).toBe(680);
		await pointer("pointermove", 650);
		expect(intent()).toBe(1100);
		await pointer("pointerup", 650, "right", 0);
		expect(save).not.toHaveBeenCalled();
	});
	it.each(["Escape", "pointercancel"])("%s restores intent without saving", async (cancel) => {
		await mount();
		await pointer("pointerdown", 600);
		await pointer("pointermove", 620);
		if (cancel === "Escape") await key(cancel);
		else await pointer(cancel, 620);
		expect(intent()).toBe(760);
		expect(save).not.toHaveBeenCalled();
		expect(document.body.style.userSelect).toBe("");
	});
	it.each(["buttons", "blur", "hidden", "lostpointercapture", "unmount"])(
		"recovers from %s and commits once",
		async (end) => {
			document.body.style.cursor = "crosshair";
			document.body.style.userSelect = "text";
			await mount();
			await pointer("pointerdown", 600);
			await pointer("pointermove", 620);
			if (end === "buttons") await pointer("pointermove", 620, "right", 0);
			if (end === "lostpointercapture") await pointer(end, 620);
			if (end === "blur") await act(() => window.dispatchEvent(new Event("blur")));
			if (end === "hidden") {
				vi.spyOn(document, "hidden", "get").mockReturnValue(true);
				await act(() => document.dispatchEvent(new Event("visibilitychange")));
			}
			if (end === "unmount") await act(async () => root.render(null));
			expect(save).toHaveBeenCalledExactlyOnceWith({ state: { chatColumnWidth: 800 } });
			expect(document.body.style.cursor).toBe("crosshair");
			expect(document.body.style.userSelect).toBe("text");
			document.body.style.cursor = "";
			document.body.style.userSelect = "";
		},
	);
	it("ignores unrelated pointers", async () => {
		await mount();
		await pointer("pointerdown", 600);
		await pointer("pointermove", 700, "right", 1, 2);
		await pointer("pointerup", 700, "right", 0, 2);
		expect(intent()).toBe(760);
		await pointer("pointermove", 620);
		expect(intent()).toBe(800);
	});
	it("supports directional keys, reset and does not forward keys to global approval shortcuts", async () => {
		await mount();
		await key("ArrowRight");
		expect(intent()).toBe(770);
		await key("ArrowLeft", "left", true);
		expect(intent()).toBe(820);
		const globalKey = vi.fn();
		window.addEventListener("keydown", globalKey);
		await key("Enter");
		await key("a");
		await key("d");
		await key("Escape");
		window.removeEventListener("keydown", globalKey);
		expect(intent()).toBe(760);
		expect(globalKey).not.toHaveBeenCalled();
		await key("ArrowLeft");
		await act(() => handle().dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
		expect(intent()).toBe(760);
	});
	it("accounts for the empty page's existing gutters and larger composer", async () => {
		width = 900;
		await mount(true);
		expect(handle().getAttribute("aria-valuemax")).toBe("796");
		await pointer("pointerdown", 600);
		await pointer("pointermove", 900);
		expect(intent()).toBe(796);
	});
	it("changes the shared CSS width without re-rendering its expensive children", async () => {
		childRender.mockClear();
		await act(async () =>
			root.render(
				<ChatColumn sessionId="test">
					<Transcript />
				</ChatColumn>,
			),
		);
		await act(async () => useUiPreferencesStore.getState().previewChatColumnWidth(1000));
		expect(host.firstElementChild?.getAttribute("style")).toContain("1000px");
		expect(childRender).toHaveBeenCalledTimes(1);
	});
});
