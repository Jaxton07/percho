import { type RefObject, useEffect, useState } from "react";

/** 槽位底部到胶囊之间的间距（设计基准 8px） */
const ANCHOR_GAP = 8;
/** 没有槽位渲染根时的基准位置（= 默认 TodoPanel 的 top-2） */
const BASE_TOP = 8;

/**
 * 宿主侧测量「槽位（TodoPanel）渲染根的实际占用底边」（spec D2 / 阶段 0 已放行方案）。
 *
 * 关键取舍（都是阶段 0 实测出来的）：
 * - 槽位宿主是 `display: contents`（不产生盒子、不成为绝对定位包含块）⇒ 插件/默认 Todo 的原绝对定位不受影响；
 *   代价是它自己没有盒，**不能**观察它，只能观察它的**渲染根**（element children，可能多个）。
 * - **多根**（插件返回 Fragment / 两个顶级节点）都要观察，取它们 rect 里的**最大 bottom** 作为底边；
 *   `display: contents` 包层与 0 高度节点不算「可占位」（它们的 rect 全 0）。
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

		/** 可占位的渲染根：element children 里 rect 有高度的那几个（多根都要） */
		const occupyingRoots = (): HTMLElement[] =>
			Array.from(host.children).filter((child): child is HTMLElement => {
				if (!(child instanceof HTMLElement)) return false;
				return child.getBoundingClientRect().height > 0;
			});

		const apply = () => {
			const roots = occupyingRoots();
			if (roots.length === 0) {
				stackEl.style.top = `${BASE_TOP}px`;
				setHasAnchor(false);
				return;
			}
			const bottom = Math.max(...roots.map((root) => root.getBoundingClientRect().bottom));
			// 坐标基准 = 最近的定位祖先（main，`position: relative`）
			const parent = stackEl.offsetParent;
			const parentTop = parent instanceof HTMLElement ? parent.getBoundingClientRect().top : 0;
			stackEl.style.top = `${bottom - parentTop + ANCHOR_GAP}px`;
			setHasAnchor(true);
		};

		const resizeObserver = new ResizeObserver(apply);
		const observed = new Set<HTMLElement>();
		// 渲染根集合变了（挂载/卸载/多根增删/插件热重载换组件）⇒ 整体重绑 + 立刻重算
		const rebind = () => {
			for (const root of observed) resizeObserver.unobserve(root);
			observed.clear();
			for (const root of occupyingRoots()) {
				resizeObserver.observe(root);
				observed.add(root);
			}
			apply();
		};
		const mutationObserver = new MutationObserver(rebind);
		mutationObserver.observe(host, { childList: true });

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
