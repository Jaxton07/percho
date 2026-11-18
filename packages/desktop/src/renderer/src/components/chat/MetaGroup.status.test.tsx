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
	expect(container.textContent).toContain("first arg");
	await render([thinking, first, second]);
	expect(container.textContent).toContain("second_tool");
	expect(container.textContent).toContain("second arg");
	await act(() => vi.advanceTimersByTime(1000));
	expect(container.textContent).toContain("second_tool");
	await render([], false);
	expect(container.textContent).not.toContain(zh.message.thinkingLabel);
	await render([thinking]);
	expect(container.textContent).toContain(zh.message.thinkingLabel);
});

it.each(["zh", "en"] as const)("%s 工具标题、预览与展开交互", async (language) => {
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
		output: "",
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
	expect(summary.textContent).toContain("argument-value");
	expect(summary.querySelector("[data-orb]")).not.toBeNull();
	expect(container.querySelector(".meta-dot-running")).not.toBeNull();
	const name = required(summary.querySelector("[data-shimmer-name]"));
	expect(name.classList.contains("font-bold")).toBe(true);
	expect(required(name.parentElement).textContent).toContain("argument-value");
	expect(name.nextElementSibling?.classList.contains("font-bold")).toBe(false);
	await act(() => summary.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
	expect(summary.closest("details")?.open).toBe(true);
	expect(summary.querySelectorAll("[data-shimmer-name]")).toHaveLength(1);
	expect(summary.querySelector("[data-shimmer-name]")?.textContent).toBe("custom_tool");
	expect(name.nextElementSibling?.classList.contains("group-open/outer:hidden")).toBe(true);
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
});
