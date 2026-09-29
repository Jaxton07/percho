import { type RefObject, useLayoutEffect, useRef } from "react";

/** 与顶栏拖拽让位（`SORT_EASE` 220ms）同一手感：增删让位和拖拽让位不该是两套节奏 */
const SHIFT_EASE = "cubic-bezier(0.2, 0, 0, 1)";
const SHIFT_DURATION = 220;
/** 新出现的项淡入（比让位短，避免和让位叠加时显得拖沓） */
const APPEAR_DURATION = 140;

export function prefersReducedMotion(): boolean {
	return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

interface ItemBox {
	x: number;
	y: number;
	el: HTMLElement;
}

/**
 * 列表**增删**时让其余项滑动到位（FLIP），而不是瞬间跳位。
 *
 * 为什么不用 View Transitions：它会把整页做成快照（含根快照跨淡），和流式正文、侧栏宽度过渡叠加
 * 容易出闪；这里只需要一列胶囊/一列短线，自己量前后位置更可控、也更好测。
 *
 * 为什么只处理「增删」不处理「重排」：重排只来自 dnd-kit 拖拽，而它自带让位/落位过渡
 * （`useSortable({transition})`）—— 两套都上会互相打架。
 *
 * 约定：容器内每个项带 `data-shift-key="<稳定 id>"`；位置取 `offsetLeft/offsetTop`
 * （相对 offsetParent，天然免疫容器自身滚动 —— 用 `getBoundingClientRect` 会因为
 * 顶栏横向滚动产生幻影位移）。返回的 ref 挂到容器上。
 *
 * 每次渲染都记录位置（只在 key 变化时记录会拿到过期基线）；`skip` 用于拖拽在途时让位。
 */
export function useListShift(opts?: { skip?: boolean }): RefObject<HTMLDivElement | null> {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const prev = useRef(new Map<string, ItemBox>());
	const skip = opts?.skip ?? false;

	useLayoutEffect(() => {
		const container = containerRef.current;
		if (!container) return;
		const items = new Map<string, ItemBox>();
		for (const el of container.querySelectorAll<HTMLElement>("[data-shift-key]")) {
			const key = el.dataset.shiftKey;
			if (key) items.set(key, { x: el.offsetLeft, y: el.offsetTop, el });
		}
		const before = prev.current;
		const added = [...items.keys()].filter((key) => !before.has(key));
		const removedKeys = [...before.keys()].filter((key) => !items.has(key));
		// 只在集合真的变了才动（纯重排交给 dnd-kit）；首帧（before 为空）不动
		const setChanged = before.size > 0 && (added.length > 0 || removedKeys.length > 0);
		if (setChanged && !skip && !prefersReducedMotion()) {
			for (const [key, item] of items) {
				const from = before.get(key);
				if (!from) {
					item.el.animate([{ opacity: 0 }, { opacity: 1 }], {
						duration: APPEAR_DURATION,
						easing: SHIFT_EASE,
					});
					continue;
				}
				const dx = from.x - item.x;
				const dy = from.y - item.y;
				if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
				item.el.animate(
					[{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0px, 0px)" }],
					{ duration: SHIFT_DURATION, easing: SHIFT_EASE },
				);
			}
		}
		prev.current = items;
	});

	return containerRef;
}
