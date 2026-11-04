// @vitest-environment happy-dom
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../i18n", () => ({ useT: () => (key: string) => key }));

import { MessageRail } from "./MessageRail";
import { nodeY, RAIL_STYLE, type RailNode } from "./message-rail";

const nodes: RailNode[] = [
	{ key: "nav:e0", excerpt: "未加载的第一条", index: -1, entryId: "e0" },
	{ key: "u1", excerpt: "第二条消息", index: 0, entryId: "e1" },
	{ key: "u2", excerpt: "第三条消息", index: 4, entryId: "e2" },
];

let root: Root;
let host: HTMLDivElement;

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
	document.body.append(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(async () => root.unmount());
	host.remove();
	vi.unstubAllGlobals();
});

async function render(list: RailNode[] = nodes, onJump = vi.fn(), active = 1) {
	await act(async () =>
		root.render(
			<MessageRail
				nodes={list}
				activeOrdinal={active}
				onJump={onJump}
				onWheel={() => {}}
				inset={0}
				columnRef={createRef<HTMLElement>()}
			/>,
		),
	);
	return onJump;
}
const listbox = () => {
	const el = host.querySelector<HTMLElement>("[role='listbox']");
	if (!el) throw new Error("listbox missing");
	el.getBoundingClientRect = () =>
		({ top: 0, left: 0, right: 16, bottom: 600, width: 16, height: 600 }) as DOMRect;
	return el;
};
const options = () => [...host.querySelectorAll<HTMLElement>("[data-rail-node]")];

describe("MessageRail", () => {
	it("少于 3 条不显示", async () => {
		await render(nodes.slice(0, 2));
		expect(host.querySelector("[data-message-rail]")).toBeNull();
	});

	it("聚焦梯度：宽度只由与当前节点的距离决定，左端对齐；当前节点变化时梯度跟随", async () => {
		const list: RailNode[] = Array.from({ length: 9 }, (_, i) => ({
			key: `k${i}`,
			excerpt: `q${i}`,
			index: i,
		}));
		const widths = () =>
			[...host.querySelectorAll<HTMLElement>("[data-rail-tick]")].map((el) =>
				Number.parseFloat(el.style.width),
			);
		await render(list, vi.fn(), 4);
		const [w0, w1, w2, w3, w4] = RAIL_STYLE.widths;
		expect(widths()).toEqual([w4, w3, w2, w1, w0, w1, w2, w3, w4]);
		expect(options().every((el) => el.className.includes("left-0"))).toBe(true);
		await render(list, vi.fn(), 0);
		expect(widths().slice(0, 4)).toEqual([w0, w1, w2, w3]);
		expect(widths().slice(4)).toEqual([w4, w4, w4, w4, w4]);
	});

	it("悬停只给指针节点轻量反馈，不移动梯度中心、不改当前节点", async () => {
		const list: RailNode[] = Array.from({ length: 9 }, (_, i) => ({
			key: `k${i}`,
			excerpt: `q${i}`,
			index: i,
		}));
		await render(list, vi.fn(), 4);
		const rail = listbox();
		await act(async () =>
			rail.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientY: nodeY(8) })),
		);
		const ticks = [...host.querySelectorAll<HTMLElement>("[data-rail-tick]")];
		expect(Number.parseFloat(ticks[4]?.style.width ?? "0")).toBe(RAIL_STYLE.widths[0]);
		expect(Number.parseFloat(ticks[8]?.style.width ?? "0")).toBe(RAIL_STYLE.widths[2]);
		expect(
			options()
				.filter((el) => el.dataset.active)
				.map((el) => el.dataset.railNode),
		).toEqual(["k4"]);
	});

	it("未加载节点也在列中，只有当前节点激活", async () => {
		await render();
		expect(options().map((el) => el.dataset.railNode)).toEqual(["nav:e0", "u1", "u2"]);
		expect(options()[0]?.dataset.unloaded).toBe("true");
		expect(
			options()
				.filter((el) => el.dataset.active)
				.map((el) => el.dataset.railNode),
		).toEqual(["u1"]);
	});

	it("点击按 y 命中最近节点并跳转；鼠标按下不拿焦点（否则轨道会钉在键盘选择态）", async () => {
		const onJump = await render();
		const rail = listbox();
		const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientY: nodeY(2) + 1 });
		await act(async () => rail.dispatchEvent(down));
		expect(down.defaultPrevented).toBe(true);
		await act(async () =>
			rail.dispatchEvent(new MouseEvent("click", { bubbles: true, clientY: nodeY(2) + 1 })),
		);
		expect(onJump).toHaveBeenCalledWith(nodes[2]);
	});

	it("悬停停稳后只显示指针下那一个节点的浮动预览；路过不显示；移出收起；悬停不改变当前节点", async () => {
		vi.useFakeTimers();
		await render();
		const rail = listbox();
		const preview = () => document.body.querySelectorAll("[data-rail-preview]");
		await act(async () =>
			rail.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientY: nodeY(0) })),
		);
		expect(preview()).toHaveLength(0);
		await act(async () => vi.advanceTimersByTime(200));
		expect(preview()).toHaveLength(1);
		expect(preview()[0]?.querySelector("[data-rail-preview-title]")?.textContent).toBe("未加载的第一条");
		// 预览 portal 到 body，不在导航条里，不参与布局
		expect(host.querySelector("[data-rail-preview]")).toBeNull();
		expect(
			options()
				.filter((el) => el.dataset.active)
				.map((el) => el.dataset.railNode),
		).toEqual(["u1"]);
		await act(async () =>
			rail.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body })),
		);
		expect(preview()).toHaveLength(0);
		vi.useRealTimers();
	});

	it("键盘：聚焦从当前节点开始，上下键逐个移动，Enter 跳转", async () => {
		const onJump = await render();
		const rail = listbox();
		await act(async () => rail.focus());
		expect(rail.getAttribute("aria-activedescendant")).toBe("message-rail-1");
		await act(async () =>
			rail.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })),
		);
		expect(rail.getAttribute("aria-activedescendant")).toBe("message-rail-0");
		await act(async () => rail.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
		await act(async () => rail.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
		expect(onJump).toHaveBeenCalledWith(nodes[2]);
	});
});
