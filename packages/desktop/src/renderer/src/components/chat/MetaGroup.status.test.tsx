// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { en } from "../../i18n/en";
import { zh } from "../../i18n/zh";
import { MetaGroup } from "./MetaGroup";

vi.mock("thinking-orbs", () => ({ ThinkingOrb: () => <span data-orb="" /> }));

const locale = vi.hoisted(() => ({ language: "zh" as "zh" | "en" }));
vi.mock("../../i18n", async () => {
	const { en } = await import("../../i18n/en");
	const { zh } = await import("../../i18n/zh");
	return {
		useT: () => (key: string) =>
			key
				.split(".")
				.reduce<unknown>(
					(node, part) => (node as Record<string, unknown>)?.[part],
					locale.language === "zh" ? zh : en,
				) ?? key,
	};
});

function required<T>(value: T | null | undefined): T {
	if (value == null) throw new Error("Missing expected element or root");
	return value;
}

let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement | undefined;
afterEach(async () => {
	await act(() => root?.unmount());
	container?.remove();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

it("思考切换工具及连续工具时立即显示当前名称，等待间隙不伪装思考", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.useFakeTimers();
	vi.setSystemTime(10_000);
	locale.language = "zh";
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	const thinking = { id: "thinking", kind: "thinking" as const, text: "reason" };
	const first = { id: "first", kind: "tool" as const, name: "first_tool", args: "first arg" };
	const second = { id: "second", kind: "tool" as const, name: "second_tool", args: "second arg" };
	const render = async (activity: (typeof thinking | typeof first)[], working = true) => {
		if (!root) throw new Error("Missing root");
		await act(() =>
			root?.render(<MetaGroup items={[{ thinking: "", tools: [], activity }]} working={working} />),
		);
	};
	await render([]);
	expect(container.textContent).toContain(zh.message.working);
	await render([thinking]);
	expect(container.textContent).toContain(zh.message.thinkingLabel);
	await render([thinking, first]);
	expect(container.textContent).not.toContain(zh.message.thinkingLabel);
	expect(container.textContent).toContain("first_tool");
	expect(container.textContent).not.toContain("first arg");
	const summary = required(container.querySelector("summary"));
	const particles = required(summary.querySelector('svg[aria-hidden="true"]'));
	await render([thinking, first, second]);
	expect(container.textContent).toContain("second_tool");
	expect(container.textContent).not.toContain("second arg");
	expect(summary.querySelector('svg[aria-hidden="true"]')).toBe(particles);
	expect(summary.textContent).not.toContain("first_tool");
	await act(() => vi.advanceTimersByTime(1000));
	expect(container.textContent).toContain("second_tool");
	await render([], false);
	expect(container.textContent).not.toContain(zh.message.thinkingLabel);
	await render([thinking]);
	expect(container.textContent).toContain(zh.message.thinkingLabel);
	expect(summary.textContent).not.toContain("reason");
	expect(summary.querySelector('svg[aria-hidden="true"]')).toBe(particles);
});

it.each(["zh", "en"] as const)("%s 工具标题、粒子与完整详情展开交互", async (language) => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	locale.language = language;
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	const tool = {
		key: "1",
		id: "1",
		name: "custom_tool",
		args: "argument-value",
		output: "output-value",
		state: "running" as const,
	};
	const items = [
		{
			thinking: "",
			tools: [tool],
			activity: [{ id: "a", kind: "tool" as const, name: tool.name, args: tool.args }],
		},
	];
	await act(() => required(root).render(<MetaGroup items={items} working />));
	const summary = required(container.querySelector("summary"));
	expect(summary.textContent).not.toContain((language === "zh" ? zh : en).message.working);
	expect(summary.textContent).toContain("custom_tool");
	expect(summary.textContent).not.toContain("argument-value");
	expect(summary.querySelector("[data-orb]")).not.toBeNull();
	expect(container.querySelector(".meta-dot-running")).not.toBeNull();
	const name = required([...summary.querySelectorAll("span")].find((el) => el.textContent === "custom_tool"));
	const particles = required(summary.querySelector('svg[aria-hidden="true"]'));
	expect(name.classList.contains("font-bold")).toBe(true);
	expect(required(name.parentElement).textContent).not.toContain("argument-value");
	expect(name.nextElementSibling?.classList.contains("font-bold")).toBe(false);
	await act(() => summary.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
	expect(summary.closest("details")?.open).toBe(true);
	expect(summary.querySelector('svg[aria-hidden="true"]')).toBe(particles);
	expect(summary.textContent).toContain("custom_tool");
	const detail = required(container.querySelector("details details summary"));
	await act(() => detail.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
	expect(container.textContent).toContain("argument-value");
	expect(container.textContent).toContain("output-value");
	await act(() => summary.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
	expect(summary.closest("details")?.open).toBe(false);
	const thinking = [
		{ thinking: "", tools: [], activity: [{ id: "think", kind: "thinking" as const, text: "reason" }] },
	];
	await act(() => required(root).render(<MetaGroup items={thinking} working />));
	const label = required(
		[...summary.querySelectorAll("span")].find(
			(el) => el.textContent === (language === "zh" ? zh : en).message.thinkingLabel,
		),
	);
	expect(label.classList.contains("font-bold")).toBe(name.classList.contains("font-bold"));
	await act(() => required(root).render(<MetaGroup items={items} working />));
	expect(summary.textContent).not.toContain((language === "zh" ? zh : en).message.working);
	const finished = [
		{
			thinking: "",
			tools: [
				{ ...tool, state: "done" as const },
				{ ...tool, key: "2", id: "2", state: "done" as const },
			],
		},
	];
	await act(() => required(root).render(<MetaGroup items={finished} working={false} endImmediately />));
	expect(summary.textContent).not.toContain((language === "zh" ? zh : en).message.thinkingLabel);
	expect(summary.textContent).toContain("custom_tool");
	expect(summary.textContent).toContain("2");
	expect(container.querySelectorAll(".meta-dot-running")).toHaveLength(0);
	expect(summary.querySelector('svg[aria-hidden="true"]')).toBeNull();
});

it("流式增长与窗口变化只调整粒子几何，活动切换保留动画组并清理监听", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	locale.language = "zh";
	const geometry = vi
		.spyOn(SVGElement.prototype, "getBoundingClientRect")
		.mockReturnValue(new DOMRect(0, 0, 900, 24));
	const focused = vi.spyOn(document, "hasFocus").mockReturnValue(true);
	const disconnect = vi.fn();
	let resize: ((width: number) => void) | undefined;
	vi.stubGlobal(
		"ResizeObserver",
		class {
			constructor(callback: ResizeObserverCallback) {
				resize = (width: number) =>
					callback(
						[{ contentRect: new DOMRect(0, 0, width, 24) } as ResizeObserverEntry],
						this as unknown as ResizeObserver,
					);
			}
			observe() {}
			disconnect = disconnect;
		},
	);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	const render = async (name: string, args: string) =>
		act(() =>
			required(root).render(
				<MetaGroup
					working
					items={[{ thinking: "", tools: [], activity: [{ id: "current", kind: "tool", name, args }] }]}
				/>,
			),
		);
	await render("first_tool", "initial raw argument");
	const summary = required(container.querySelector("summary"));
	const particles = required(summary.querySelector('svg[aria-hidden="true"]'));
	const groups = [...particles.querySelectorAll("g")];
	expect(groups).toHaveLength(9);
	expect(particles.querySelectorAll("circle")).toHaveLength(270);
	const reads = geometry.mock.calls.length;
	for (let i = 0; i < 5; i++) await render("first_tool", "growing raw argument ".repeat(i + 1));
	await render("latest_tool", "latest raw argument");
	expect(summary.textContent).toBe("latest_tool");
	expect(summary.querySelector('svg[aria-hidden="true"]')).toBe(particles);
	expect([...particles.querySelectorAll("g")]).toEqual(groups);
	expect(geometry).toHaveBeenCalledTimes(reads);
	await act(() => required(resize)(300));
	expect(particles.querySelectorAll("circle").length).toBeGreaterThan(0);
	expect(particles.querySelectorAll("circle").length).toBeLessThan(270);
	expect([...particles.querySelectorAll("g")]).toEqual(groups);
	await act(() => required(resize)(0));
	expect(particles.querySelectorAll("circle")).toHaveLength(0);
	const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
	await act(() => document.dispatchEvent(new Event("visibilitychange")));
	expect(particles.hasAttribute("data-paused")).toBe(true);
	hidden.mockReturnValue(false);
	await act(() => document.dispatchEvent(new Event("visibilitychange")));
	expect(particles.hasAttribute("data-paused")).toBe(false);
	focused.mockReturnValue(false);
	await act(() => window.dispatchEvent(new Event("blur")));
	expect(particles.hasAttribute("data-paused")).toBe(true);
	focused.mockReturnValue(true);
	await act(() => window.dispatchEvent(new Event("focus")));
	expect(particles.hasAttribute("data-paused")).toBe(false);
	await act(() => required(root).unmount());
	root = undefined;
	expect(disconnect).toHaveBeenCalledOnce();
});

it("保留短间隙缓冲，真实结束立即撤下粒子；完整思考仍按需展开", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.useFakeTimers();
	locale.language = "zh";
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	const item = {
		thinking: "full thinking value",
		tools: [],
		activity: [{ id: "think", kind: "thinking" as const, text: "full thinking value" }],
	};
	const render = (working: boolean, endImmediately = false) =>
		act(() =>
			required(root).render(<MetaGroup working={working} endImmediately={endImmediately} items={[item]} />),
		);
	await render(true);
	const summary = required(container.querySelector("summary"));
	const particles = required(summary.querySelector('svg[aria-hidden="true"]'));
	expect(summary.textContent).not.toContain("full thinking value");
	await render(false);
	await act(() => vi.advanceTimersByTime(1499));
	expect(summary.querySelector('svg[aria-hidden="true"]')).toBe(particles);
	await render(true);
	await act(() => vi.advanceTimersByTime(10));
	expect(summary.querySelector('svg[aria-hidden="true"]')).toBe(particles);
	await act(() => summary.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
	const thinkingSummary = required(container.querySelector("details details summary"));
	await act(() =>
		thinkingSummary.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })),
	);
	expect(container.textContent).toContain("full thinking value");
	await render(false, true);
	expect(particles.isConnected).toBe(false);
});
