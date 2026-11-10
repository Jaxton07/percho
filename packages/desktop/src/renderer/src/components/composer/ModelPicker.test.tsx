// @vitest-environment happy-dom
import type { AvailableModel } from "@percho/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ModelPicker } from "./ModelPicker";

const { models, setCurrentModel } = vi.hoisted(() => ({
	models: ["standard", "extended", "preview", "short"].map((suffix) => ({
		provider: "test-provider",
		providerName: "Test Provider",
		id: `model-${suffix}`,
		label: suffix === "short" ? "Short model" : `gateway-${"long-model-name-".repeat(8)}${suffix}`,
		authed: true,
	})),
	setCurrentModel: vi.fn(),
}));
vi.mock("../../stores/sessions", () => ({
	useSessionsStore: (
		selector: (state: { models: AvailableModel[]; setCurrentModel: typeof setCurrentModel }) => unknown,
	) => selector({ models, setCurrentModel }),
}));
vi.mock("../../hooks/use-session-state", () => ({
	useActiveModelInfo: () => models[0],
	useThinkingLevelState: () => ({ supported: ["off"], display: "off" }),
}));
vi.mock("../../i18n", () => ({ useT: () => (key: string) => key }));
vi.mock("./ThinkingSlider", () => ({ ThinkingSlider: () => null }));

let host: HTMLDivElement;
let root: Root;
beforeEach(async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.useFakeTimers();
	setCurrentModel.mockClear();
	// happy-dom has no layout; model the measured text width, not just the label length in production.
	vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
		return this.matches("[data-model-key] > .truncate") ? (this.textContent?.length ?? 0) * 8 : 0;
	});
	vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(200);
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(() => root.render(<ModelPicker />));
	await act(() => host.querySelector("button")?.click());
});
afterEach(async () => {
	await act(() => root.unmount());
	host.remove();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
const rows = () => Array.from(host.querySelectorAll<HTMLButtonElement>("[data-model-key]"));
const tooltip = () => document.querySelector<HTMLSpanElement>('body > [role="tooltip"]');
const delay = async () => act(() => vi.advanceTimersByTime(300));
const key = async (value: string) =>
	act(() =>
		host
			.querySelector("input")
			?.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true })),
	);

it("shows the full hovered label outside the scroll container without changing selection", async () => {
	const row = rows()[1];
	if (!row) throw new Error("Missing model row");
	await act(() => row.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
	expect(tooltip()?.style.visibility).toBe("hidden");
	await delay();
	expect(tooltip()?.textContent).toBe(models[1]?.label);
	expect(tooltip()?.style.visibility).toBe("visible");
	expect(row.getAttribute("aria-describedby")).toBe(tooltip()?.id);
	expect(row.querySelector(".truncate")?.textContent).toBe(models[1]?.label);
	expect(setCurrentModel).not.toHaveBeenCalled();
	await act(() => row.click());
	expect(setCurrentModel).toHaveBeenCalledWith("test-provider", "model-extended");
	await act(() => row.dispatchEvent(new MouseEvent("mouseout", { bubbles: true })));
	expect(tooltip()).toBeNull();
});

it("follows keyboard highlights and focus, and Escape dismisses it", async () => {
	await key("ArrowDown");
	await delay();
	expect(tooltip()?.textContent).toBe(models[1]?.label);
	expect(host.querySelector("input")?.getAttribute("aria-describedby")).toBe(tooltip()?.id);
	await key("ArrowDown");
	await delay();
	expect(tooltip()?.textContent).toBe(models[2]?.label);
	await key("Enter");
	expect(setCurrentModel).toHaveBeenCalledWith("test-provider", "model-preview");
	await act(() => rows()[0]?.focus());
	await delay();
	expect(tooltip()?.textContent).toBe(models[0]?.label);
	await act(() => rows()[0]?.blur());
	expect(tooltip()).toBeNull();
	await key("ArrowUp");
	await delay();
	expect(tooltip()).not.toBeNull();
	await key("Escape");
	expect(tooltip()).toBeNull();
	expect(rows()).toHaveLength(0);
});

it("clears stale hints on search, scrolling, and closing", async () => {
	await key("ArrowDown");
	await delay();
	const input = host.querySelector("input");
	if (!input) throw new Error("Missing search input");
	await act(() => {
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "preview");
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
	expect(rows()).toHaveLength(1);
	expect(tooltip()).toBeNull();
	await key("ArrowDown");
	await delay();
	expect(tooltip()?.textContent).toBe(models[2]?.label);
	await act(() => rows()[0]?.dispatchEvent(new WheelEvent("wheel", { bubbles: true })));
	expect(tooltip()).toBeNull();
	await key("ArrowDown");
	await act(() => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
	await delay();
	expect(tooltip()).toBeNull();
});

it("does not describe or show an untruncated short name on hover, keyboard highlight, or focus", async () => {
	const row = rows()[3];
	if (!row) throw new Error("Missing short model row");
	await key("ArrowDown");
	await delay();
	expect(tooltip()).not.toBeNull();
	await act(() => row.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
	await delay();
	expect(tooltip()).toBeNull();
	expect(row.hasAttribute("aria-describedby")).toBe(false);
	expect(host.querySelector("input")?.hasAttribute("aria-describedby")).toBe(false);
	await key("ArrowUp");
	await delay();
	expect(tooltip()?.textContent).toBe(models[2]?.label);
	await key("ArrowDown");
	await delay();
	expect(tooltip()).toBeNull();
	await act(() => row.focus());
	await delay();
	expect(tooltip()).toBeNull();
	expect(row.hasAttribute("aria-describedby")).toBe(false);
	await act(() => row.click());
	expect(setCurrentModel).toHaveBeenCalledWith("test-provider", "model-short");
});

it.each([199, 200])("uses actual overflow, not name length (text width %s, available 200)", async (width) => {
	const row = rows()[1];
	const label = row?.querySelector<HTMLElement>(".truncate");
	if (!row || !label) throw new Error("Missing long model label");
	const measuredWidth = vi.spyOn(label, "scrollWidth", "get").mockReturnValue(width);
	await act(() => row.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
	await delay();
	expect(tooltip()).toBeNull();
	expect(row.hasAttribute("aria-describedby")).toBe(false);
	await act(() => row.focus());
	await delay();
	expect(tooltip()).toBeNull();
	await key("ArrowUp");
	await key("ArrowDown");
	await delay();
	expect(tooltip()).toBeNull();
	expect(host.querySelector("input")?.hasAttribute("aria-describedby")).toBe(false);
	measuredWidth.mockReturnValue(201);
	await key("ArrowUp");
	await key("ArrowDown");
	await delay();
	expect(tooltip()?.textContent).toBe(models[1]?.label);
});

it("flips and clamps the hint at viewport edges, wrapping even unbroken labels", async () => {
	vi.stubGlobal("innerWidth", 320);
	vi.stubGlobal("innerHeight", 240);
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
		return this.getAttribute("role") === "tooltip"
			? new DOMRect(0, 0, 280, 80)
			: new DOMRect(200, 210, 110, 24);
	});
	await key("ArrowDown");
	await delay();
	const hint = tooltip();
	expect(hint?.style.left).toBe("30px");
	expect(hint?.style.top).toBe("126px");
	expect(hint?.className).toContain("[overflow-wrap:anywhere]");
	expect(hint?.className).toContain("whitespace-normal");
	vi.stubGlobal("innerWidth", 300);
	await act(() => window.dispatchEvent(new Event("resize")));
	expect(hint?.style.left).toBe("14px");
});
