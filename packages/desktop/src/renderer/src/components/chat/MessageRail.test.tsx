// @vitest-environment happy-dom
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const locale = vi.hoisted(() => ({ current: "zh" }));
vi.mock("../../i18n", () => ({
	useT: () => () => (locale.current === "zh" ? "对话导航" : "Conversation navigation"),
}));

import { MessageRail } from "./MessageRail";
import type { RailNode } from "./message-rail";

const make = (count: number): RailNode[] =>
	Array.from({ length: count }, (_, i) => ({
		key: i === 0 ? "nav:e0" : `u${i}`,
		excerpt: `问题 ${i}`,
		reply: i % 2 ? `回复 ${i}` : undefined,
		index: i === 0 ? -1 : i * 2,
		entryId: `e${i}`,
	}));

let root: Root;
let host: HTMLDivElement;
let column: HTMLDivElement;

beforeEach(() => {
	locale.current = "zh";
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			disconnect() {}
		},
	);
	host = document.createElement("div");
	host.style.position = "relative";
	column = document.createElement("div");
	host.append(column);
	document.body.append(host);
	// 正文列在左侧留出足够空带
	column.getBoundingClientRect = () =>
		({ left: 400, top: 0, right: 1160, bottom: 800, width: 760, height: 800 }) as DOMRect;
	Object.defineProperty(column, "offsetParent", { configurable: true, get: () => host });
	host.getBoundingClientRect = () =>
		({ left: 0, top: 0, right: 1280, bottom: 800, width: 1280, height: 800 }) as DOMRect;
	root = createRoot(host);
});
afterEach(async () => {
	await act(async () => root.unmount());
	host.remove();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

async function render(
	nodes: RailNode[],
	inView: { from: number; to: number } | null = null,
	onJump = vi.fn(),
) {
	const ref = createRef<HTMLDivElement>();
	(ref as { current: HTMLDivElement | null }).current = column;
	await act(async () =>
		root.render(<MessageRail nodes={nodes} inView={inView} onJump={onJump} inset={0} columnRef={ref} />),
	);
	return onJump;
}
const items = () => [...host.querySelectorAll<HTMLElement>("[data-rail-index]")];
const markers = () => items().map((el) => el.querySelector<HTMLElement>(".message-rail-marker"));
const over = (index: number) =>
	act(async () => items()[index]?.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })));

describe("MessageRail", () => {
	it("千轮只挂载视口附近，滚动两端的点击、悬停与拖动使用全局序号", async () => {
		vi.useFakeTimers();
		const nodes = make(1000);
		const jump = await render(nodes);
		const rail = host.querySelector<HTMLElement>(".message-rail-list");
		if (!rail) throw new Error("missing rail");
		Object.defineProperty(rail, "clientHeight", { configurable: true, value: 100 });
		Object.defineProperty(rail, "scrollHeight", { configurable: true, value: 10000 });
		rail.getBoundingClientRect = () =>
			({ top: 0, bottom: 100, left: 0, right: 36, width: 36, height: 100 }) as DOMRect;
		rail.setPointerCapture = vi.fn();
		await act(async () => rail.dispatchEvent(new Event("scroll")));
		expect(items().length).toBeLessThanOrEqual(18);
		await act(async () => items()[0]?.click());
		expect(jump).toHaveBeenLastCalledWith(nodes[0], "smooth");
		rail.scrollTop = 9900;
		await act(async () => rail.dispatchEvent(new Event("scroll")));
		expect(items().length).toBeLessThanOrEqual(18);
		const last = host.querySelector<HTMLElement>('[data-rail-index="999"]');
		if (!last) throw new Error("missing last marker");
		await act(async () => last.click());
		expect(jump).toHaveBeenLastCalledWith(nodes[999], "smooth");
		await act(async () => last.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })));
		await act(async () => vi.advanceTimersByTime(160));
		expect(host.querySelector("[data-rail-preview-title]")?.textContent).toBe("问题 999");
		expect(
			host.querySelector<HTMLElement>('[data-rail-index="998"] .message-rail-marker')?.dataset.near,
		).toBe("1");
		const pointer = (type: string, y: number) =>
			new PointerEvent(type, { bubbles: true, pointerId: 7, button: 0, clientY: y });
		await act(async () => last.dispatchEvent(pointer("pointerdown", 95)));
		await act(async () => rail.dispatchEvent(pointer("pointermove", 5)));
		expect(jump).toHaveBeenLastCalledWith(nodes[989], "instant");
		await act(async () => rail.dispatchEvent(pointer("pointercancel", 5)));
		expect(rail.dataset.scrubbing).toBeUndefined();
		const calls = jump.mock.calls.length;
		await act(async () => vi.advanceTimersByTime(100));
		expect(jump).toHaveBeenCalledTimes(calls);
		const firstVisible = items()[4];
		if (!firstVisible) throw new Error("missing visible marker");
		await act(async () => firstVisible.dispatchEvent(pointer("pointerdown", 5)));
		const beforeEdge = rail.scrollTop;
		await act(async () => rail.dispatchEvent(pointer("pointermove", -10)));
		await act(async () => vi.advanceTimersByTime(48));
		expect(rail.scrollTop).toBeLessThan(beforeEdge - 10);
		await act(async () => rail.dispatchEvent(pointer("lostpointercapture", 5)));
		expect(rail.dataset.scrubbing).toBeUndefined();
	});

	it("少于 4 条不显示；每条用户消息一个刻度，未加载节点也在列中", async () => {
		await render(make(3));
		expect(host.querySelector("[data-message-rail]")).toBeNull();
		await render(make(6));
		expect(items()).toHaveLength(6);
		expect(items()[0]?.dataset.unloaded).toBe("true");
		expect(host.querySelector(".message-rail-list")).not.toBeNull();
	});

	it("视口内的轮次全部提亮（可多条），其余不提亮；没有悬停时没有放大", async () => {
		await render(make(8), { from: 2, to: 4 });
		expect(items().map((el) => el.getAttribute("aria-current"))).toEqual([
			null,
			null,
			"true",
			"true",
			"true",
			null,
			null,
			null,
		]);
		expect(markers().every((el) => el?.dataset.near === undefined)).toBe(true);
	});

	it("悬停：指针刻度 data-hot，相邻三格按距离 1/2/3 标记；离开后恢复，阅读提亮不变", async () => {
		vi.useFakeTimers();
		await render(make(10), { from: 1, to: 1 });
		await over(5);
		expect(items()[5]?.dataset.hot).toBe("true");
		expect(markers().map((el) => el?.dataset.near ?? null)).toEqual([
			null,
			null,
			"3",
			"2",
			"1",
			"0",
			"1",
			"2",
			"3",
			null,
		]);
		expect(items()[1]?.getAttribute("aria-current")).toBe("true");
		await act(async () =>
			host
				.querySelector("[data-message-rail]")
				?.dispatchEvent(new MouseEvent("pointerout", { bubbles: true })),
		);
		await act(async () => {
			host.querySelector("[data-message-rail]")?.dispatchEvent(new Event("pointerleave"));
		});
	});

	it("卡片 150ms 后才出现，只有一张：标题 = 提问，摘要 = 回复", async () => {
		vi.useFakeTimers();
		await render(make(6));
		await over(3);
		expect(host.querySelectorAll("[data-rail-preview]")).toHaveLength(0);
		await act(async () => vi.advanceTimersByTime(160));
		const cards = host.querySelectorAll("[data-rail-preview]");
		expect(cards).toHaveLength(1);
		expect(cards[0]?.querySelector("[data-rail-preview-title]")?.textContent).toBe("问题 3");
		expect(cards[0]?.querySelector("[data-rail-preview-reply]")?.textContent).toBe("回复 3");
	});

	it("点击平滑跳转到该节点（含未加载节点）", async () => {
		const nodes = make(6);
		const onJump = await render(nodes);
		await act(async () => items()[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(onJump).toHaveBeenCalledWith(nodes[0], "smooth");
	});

	it("悬停中的活动回复持续更新，刻度身份保持不变", async () => {
		vi.useFakeTimers();
		const nodes = make(6);
		await render(nodes, { from: 5, to: 5 });
		await over(5);
		await act(async () => vi.advanceTimersByTime(160));
		const before = items();
		for (const reply of ["首段回复", "首段回复继续输出"]) {
			await render(
				nodes.map((node, i) => (i === 5 ? { ...node, reply } : node)),
				{ from: 5, to: 5 },
			);
			expect(host.querySelector("[data-rail-preview-reply]")?.textContent).toBe(reply);
			expect(items().every((el, i) => el === before[i])).toBe(true);
		}
	});

	it("切换界面语言刷新导航标签，不改变当前预览归属", async () => {
		vi.useFakeTimers();
		const nodes = make(6);
		await render(nodes);
		await over(3);
		await act(async () => vi.advanceTimersByTime(160));
		expect(host.querySelector("[data-message-rail]")?.getAttribute("aria-label")).toBe("对话导航");
		locale.current = "en";
		await render(nodes);
		expect(host.querySelector("[data-message-rail]")?.getAttribute("aria-label")).toBe(
			"Conversation navigation",
		);
		expect(host.querySelector("[data-rail-preview-title]")?.textContent).toBe("问题 3");
		expect(host.querySelector("[data-rail-preview-reply]")?.textContent).toBe("回复 3");
	});

	it("来源重装后，同一刻度的标题和加载状态分别刷新", async () => {
		const nodes = make(6);
		await render(nodes);
		expect(items()[0]?.dataset.unloaded).toBe("true");
		const renamed = nodes.map((node, i) => (i === 0 ? { ...node, excerpt: "新的提问" } : node));
		await render(renamed);
		expect(items()[0]?.getAttribute("aria-label")).toBe("新的提问");
		await render(renamed.map((node, i) => (i === 0 ? { ...node, index: 0 } : node)));
		expect(items()[0]?.dataset.unloaded).toBeUndefined();
	});

	it("流式输出只改摘要时刻度不重绘（同一批 DOM 节点）", async () => {
		const nodes = make(6);
		await render(nodes, { from: 5, to: 5 });
		const before = items();
		await render(
			nodes.map((node, i) => (i === 5 ? { ...node, reply: "新的流式摘要" } : node)),
			{ from: 5, to: 5 },
		);
		expect(items().every((el, i) => el === before[i])).toBe(true);
	});
});
