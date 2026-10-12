import { type RefObject, useEffect, useState } from "react";
import { type AnchorTreeAdapter, occupyingBoxes, slotRoots } from "./todo-anchor";

/** 槽位底部到胶囊之间的间距（设计基准 8px） */
const ANCHOR_GAP = 8;
/** 没有槽位渲染根时的基准位置（= 默认 TodoPanel 的 top-2） */
const BASE_TOP = 8;

/** DOM 版 adapter（纯逻辑在 `todo-anchor.ts`，那里有单测） */
const domAdapter: AnchorTreeAdapter<HTMLElement> = {
	elementChildren: (node) =>
		Array.from(node.children).filter((child): child is HTMLElement => child instanceof HTMLElement),
	// 单测/非 DOM 环境没有 getComputedStyle（review 的 hook 反例就是这种最小 stub）⇒ 当作普通盒处理，
	// 这样「观察全部渲染根」这一步不会被样式读取阻断
	isDisplayContents: (node) =>
		typeof getComputedStyle === "function" && getComputedStyle(node).display === "contents",
	box: (node) => {
		const rect = node.getBoundingClientRect();
		return { width: rect.width, height: rect.height, bottom: rect.bottom };
	},
};

/**
 * 宿主侧测量「槽位（TodoPanel）渲染根的实际占用底边」（spec D2 / 阶段 0 已放行方案）。
 *
 * 关键取舍（都是实测出来的）：
 * - 槽位宿主是 `display: contents`（不产生盒子、不成为绝对定位包含块）⇒ 插件/默认 Todo 的原绝对定位不受影响；
 *   代价是它自己没有盒，**不能**观察它，只能观察它的**渲染根**（element children）。
 * - **观察集合 ≠ 测量集合**（review R11）：观察**全部**元素子节点（含当前 0 高的 —— 否则先空壳后长内容的
 *   插件永远不会被观察），测量才只算「高度 > 0 且递归穿过 contents 包层」的盒子，取最大 bottom。
 * - 位置**命令式**写到堆叠容器的 `style.top`：高度动画每帧都在变，走 React state 会带来每帧一次整树重渲染。
 *   只有「有没有 anchor」这一个布尔进 React state（很少翻转）。
 * - 只挂 ResizeObserver，不引入 rAF 轮询（阶段 0 对照实测：RO 回调里写 top 就是帧同步的）。
 *   覆盖不到「尺寸不变、仅位置变化」的插件（例如用 transform 做位移动画）—— 本期不承诺。
 */
export function useTodoAnchor({
	slotHost,
	stack,
}: {
	slotHost: RefObject<HTMLElement | null>;
	stack: RefObject<HTMLElement | null>;
}): boolean {
	const [hasAnchor, setHasAnchor] = useState(false);

	useEffect(() => {
		const host = slotHost.current;
		const stackEl = stack.current;
		if (!host || !stackEl) return;

		const apply = () => {
			const boxes = occupyingBoxes(host, domAdapter);
			if (boxes.length === 0) {
				stackEl.style.top = `${BASE_TOP}px`;
				setHasAnchor(false);
				return;
			}
			const bottom = Math.max(...boxes.map((box) => domAdapter.box(box).bottom));
			// 坐标基准 = 最近的定位祖先（main，`position: relative`）
			const parent = stackEl.offsetParent;
			const parentTop = parent instanceof HTMLElement ? parent.getBoundingClientRect().top : 0;
			stackEl.style.top = `${bottom - parentTop + ANCHOR_GAP}px`;
			setHasAnchor(true);
		};

		const resizeObserver = new ResizeObserver(apply);
		const observed = new Set<HTMLElement>();
		// 观察集合 = 全部渲染根 + 遍历到的占位盒（contents 包层没有盒子、RO 不会为它回调，要观察它里面的盒子）
		const rebind = () => {
			for (const node of observed) resizeObserver.unobserve(node);
			observed.clear();
			const targets = new Set<HTMLElement>(slotRoots(host, domAdapter));
			for (const box of occupyingBoxes(host, domAdapter)) targets.add(box);
			for (const node of targets) {
				resizeObserver.observe(node);
				observed.add(node);
			}
			apply();
		};
		// subtree: true —— 插件可能换掉 contents 包层里的子节点（根节点本身不变也得重绑）
		const mutationObserver = new MutationObserver(rebind);
		mutationObserver.observe(host, { childList: true, subtree: true });

		// main 自身尺寸/位置变化（顶栏显隐、窗口缩放）也会改变相对底边
		const parentObserver = new ResizeObserver(apply);
		const parent = stackEl.offsetParent;
		if (parent instanceof HTMLElement) parentObserver.observe(parent);
		window.addEventListener("resize", apply);

		rebind();
		return () => {
			mutationObserver.disconnect();
			resizeObserver.disconnect();
			parentObserver.disconnect();
			window.removeEventListener("resize", apply);
		};
	}, [slotHost, stack]);

	return hasAnchor;
}
