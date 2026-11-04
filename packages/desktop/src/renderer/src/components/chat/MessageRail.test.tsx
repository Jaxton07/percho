// @vitest-environment happy-dom
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../i18n", () => ({ useT: () => (key: string) => key }));

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
