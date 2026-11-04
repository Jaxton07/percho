import type { ChatRow, SessionNavigationEntry } from "@percho/shared";
import { describe, expect, it } from "vitest";
import {
	activeNode,
	columnHeight,
	NODE_GAP,
	nodeAt,
	nodeY,
	RAIL_EXCERPT_CHARS,
	RAIL_PAD,
	RAIL_STYLE,
	railNodes,
	tickWidth,
	viewHeight,
	visibleNodeRange,
	windowOffset,
} from "./message-rail";

const user = (key: string, text: string, entryId?: string): ChatRow =>
	({
		kind: "message",
		key,
		message: { kind: "user", id: key, text, images: [], timestamp: 0, entryId },
		metaInGroup: false,
		showActions: true,
		streaming: false,
	}) as unknown as ChatRow;
const assistant = (key: string): ChatRow =>
	({
		kind: "message",
		key,
		message: { kind: "assistant", id: key, text: "reply", thinking: "", tools: [], timestamp: 0 },
		metaInGroup: false,
		showActions: true,
		streaming: false,
	}) as unknown as ChatRow;
const nav = (entryId: string, excerpt = entryId): SessionNavigationEntry => ({
	entryId,
	ordinal: 0,
	excerpt,
	timestamp: 0,
	images: 0,
});

describe("railNodes", () => {
	it("只取用户消息，保留顺序与行下标，摘要折叠空白并截断", () => {
		const long = `a\n\n  b ${"x".repeat(200)}`;
		const nodes = railNodes([user("u1", long, "e1"), assistant("a1"), user("u2", "second", "e2")], null);
		expect(nodes.map((node) => [node.key, node.index])).toEqual([
			["u1", 0],
			["u2", 2],
		]);
		expect(nodes[0]?.excerpt.startsWith("a b x")).toBe(true);
		expect(nodes[0]?.excerpt).toHaveLength(RAIL_EXCERPT_CHARS);
	});

	it("服务端索引只补「早于已加载首条」的未加载部分，已加载部分以行为准", () => {
		const rows = [user("u3", "third", "e3"), assistant("a3"), user("u4", "live, not yet in index")];
		const nodes = railNodes(rows, [nav("e1", "first"), nav("e2", "second"), nav("e3", "stale excerpt")]);
		expect(nodes.map((node) => [node.key, node.index, node.entryId])).toEqual([
			["nav:e1", -1, "e1"],
			["nav:e2", -1, "e2"],
			["u3", 0, "e3"],
			["u4", 2, undefined],
		]);
		expect(nodes[2]?.excerpt).toBe("third");
	});

	it("索引里找不到已加载首条（过期/错位）时不补未加载节点", () => {
		const nodes = railNodes([user("u9", "x", "e9")], [nav("e1"), nav("e2")]);
		expect(nodes.map((node) => node.key)).toEqual(["u9"]);
	});
});

describe("activeNode", () => {
	const nodes = railNodes(
		[user("u0", "a", "e0"), assistant("a0"), user("u1", "b", "e1"), assistant("a1"), user("u2", "c", "e2")],
		[nav("old"), nav("e0")],
	);
	it("取视口首行之前最近的用户消息；长回复归属发问", () => {
		expect(activeNode(nodes, 0, 1, false)).toBe(1);
		expect(activeNode(nodes, 3, 4, false)).toBe(2);
	});
	it("到底时取视口内最后一条", () => {
		expect(activeNode(nodes, 1, 4, true)).toBe(3);
	});
	it("空列表返回 -1", () => {
		expect(activeNode([], 0, 0, false)).toBe(-1);
	});
});

describe("聚焦梯度", () => {
	it("宽度只由与聚焦节点的距离决定，两侧对称，超出序列回落到普通宽度", () => {
		const w = [40, 30, 20, 10];
		expect([0, 1, 2, 3, 4, 5, 6].map((i) => tickWidth(i, 3, w))).toEqual([10, 20, 30, 40, 30, 20, 10]);
		expect(tickWidth(100, 3, w)).toBe(10);
	});
	it("没有聚焦节点时全部是普通宽度；默认序列由长到短", () => {
		const normal = RAIL_STYLE.widths.at(-1);
		expect(tickWidth(0, -1)).toBe(normal);
		const sorted = [...RAIL_STYLE.widths].sort((a, b) => b - a);
		expect([...RAIL_STYLE.widths]).toEqual(sorted);
	});
});

describe("局部导航窗口", () => {
	const rail = 600;
	const inRail = (offset: number, ordinal: number) => {
		const y = offset + nodeY(ordinal);
		return y >= 0 && y <= rail;
	};
	it("节点放得下时全部显示、顶部对齐、不拉伸间距", () => {
		expect(windowOffset(10, rail, 9)).toBe(0);
		expect(nodeY(3) - nodeY(2)).toBe(NODE_GAP);
		expect(nodeY(0)).toBe(RAIL_PAD);
	});
	it("放不下时跟随当前节点：中间居中，首尾贴边不留空白", () => {
		const count = 3000;
		const top = windowOffset(count, rail, 0);
		expect(top).toBe(0);
		const bottom = windowOffset(count, rail, count - 1);
		expect(rail - (bottom + nodeY(count - 1))).toBe(RAIL_PAD);
		const mid = windowOffset(count, rail, 1500);
		expect(Math.abs(mid + nodeY(1500) - rail / 2)).toBeLessThanOrEqual(1);
		for (const anchor of [0, 1, 7, 1500, 2990, 2999])
			expect(inRail(windowOffset(count, rail, anchor), anchor)).toBe(true);
	});
	it("可见节点数由轨道高度与间距决定，与历史长度无关", () => {
		const small = visibleNodeRange(3000, rail, windowOffset(3000, rail, 1500));
		const big = visibleNodeRange(30000, rail, windowOffset(30000, rail, 15000));
		expect(small.to - small.from).toBeLessThan(rail / NODE_GAP + 10);
		expect(big.to - big.from).toBe(small.to - small.from);
		const tall = visibleNodeRange(3000, rail * 2, windowOffset(3000, rail * 2, 1500));
		expect(tall.to - tall.from).toBeGreaterThan(small.to - small.from);
	});
	it("可见区高度：不超过可用高度、不超过 maxVisible 个节点、少量节点只占自身高度（居中成一小簇）", () => {
		expect(viewHeight(5, 800, 25)).toBe(columnHeight(5));
		expect(viewHeight(3000, 800, 25)).toBe(columnHeight(25));
		expect(viewHeight(3000, 200, 25)).toBe(200);
		expect(viewHeight(0, 800, 25)).toBe(0);
	});
	it("可见区放不下全部时：窗口跟随锚点，首尾贴边，锚点总在可见区内", () => {
		const view = viewHeight(3000, 800);
		for (const anchor of [0, 3, 1500, 2996, 2999]) {
			const y = windowOffset(3000, view, anchor) + nodeY(anchor);
			expect(y >= 0 && y <= view).toBe(true);
		}
	});
	it("nodeAt 是 nodeY 的反函数并夹在范围内", () => {
		const offset = -300;
		expect(nodeAt(offset + nodeY(57), offset, 1000)).toBe(57);
		expect(nodeAt(-9999, offset, 1000)).toBe(0);
		expect(nodeAt(9999, offset, 10)).toBe(9);
		expect(nodeAt(0, 0, 0)).toBe(-1);
	});
});
