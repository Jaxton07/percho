import { describe, expect, it } from "vitest";
import { type AnchorTreeAdapter, anchorBottom, occupyingBoxes, slotRoots } from "./todo-anchor";

/**
 * 槽位锚点的纯逻辑（review R11 的反例就在这里）：
 * **观察集合**要含当前 0 高的根（否则「先空壳、后长内容」的插件永远不被观察）；
 * **测量集合**才只算占位盒，并且要递归穿过 `display: contents` 包层。
 */
interface FakeNode {
	name: string;
	display?: "contents" | "block";
	height?: number;
	bottom?: number;
	children?: FakeNode[];
}

const adapter: AnchorTreeAdapter<FakeNode> = {
	elementChildren: (node) => node.children ?? [],
	isDisplayContents: (node) => node.display === "contents",
	box: (node) => ({ width: 100, height: node.height ?? 0, bottom: node.bottom ?? 0 }),
};

const host = (children: FakeNode[]): FakeNode => ({ name: "host", children });

describe("slotRoots（观察集合）", () => {
	it("包含当前 0 高的根 —— 否则它长大后永远不会被观察（R11 反例）", () => {
		const empty = { name: "先渲染的空壳", height: 0 };
		const filled = { name: "有内容的根", height: 40 };
		expect(slotRoots(host([empty, filled]), adapter)).toEqual([empty, filled]);
	});

	it("空槽位（没有渲染根）返回空数组", () => {
		expect(slotRoots(host([]), adapter)).toEqual([]);
	});
});

describe("occupyingBoxes（测量集合）", () => {
	it("只算高度 > 0 的盒子", () => {
		const boxes = occupyingBoxes(
			host([
				{ name: "a", height: 0 },
				{ name: "b", height: 36 },
			]),
			adapter,
		);
		expect(boxes.map((b) => b.name)).toEqual(["b"]);
	});

	it("递归穿过 display: contents 包层（包层自己没有盒子）", () => {
		const inner = { name: "inner", height: 50, bottom: 90 };
		const wrapper = { name: "contents 包层", display: "contents" as const, children: [inner] };
		expect(occupyingBoxes(host([wrapper]), adapter)).toEqual([inner]);
	});

	it("多根 + 包层混合：都收进来", () => {
		const direct = { name: "direct", height: 20, bottom: 40 };
		const nested = { name: "nested", height: 60, bottom: 120 };
		const wrapper = { name: "w", display: "contents" as const, children: [nested] };
		expect(occupyingBoxes(host([direct, wrapper]), adapter).map((b) => b.name)).toEqual(["direct", "nested"]);
	});

	it("包层里也是 0 高：不算占位（等价于没有内容）", () => {
		const wrapper = { name: "w", display: "contents" as const, children: [{ name: "empty", height: 0 }] };
		expect(occupyingBoxes(host([wrapper]), adapter)).toEqual([]);
	});
});

describe("anchorBottom（锚点底边）", () => {
	it("取所有占位盒 bottom 的最大值（长列表最低的那个说了算）", () => {
		const hostNode = host([
			{ name: "a", height: 36, bottom: 92 },
			{ name: "b", height: 288, bottom: 380 },
		]);
		expect(anchorBottom(hostNode, adapter)).toBe(380);
	});

	it("没有占位盒 ⇒ null（调用方回落到基准位置）", () => {
		expect(anchorBottom(host([{ name: "empty", height: 0 }]), adapter)).toBeNull();
		expect(anchorBottom(host([]), adapter)).toBeNull();
	});

	it("contents 包层里的盒子照样参与取最大", () => {
		const nested = { name: "nested", height: 200, bottom: 300 };
		const hostNode = host([
			{ name: "direct", height: 10, bottom: 50 },
			{ name: "w", display: "contents" as const, children: [nested] },
		]);
		expect(anchorBottom(hostNode, adapter)).toBe(300);
	});
});
