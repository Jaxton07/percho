import { type RefObject, useLayoutEffect, useRef } from "react";

interface Point {
	x: number;
	y: number;
	layoutOnly: boolean;
}
const duration = 220;
const easing = "cubic-bezier(0.2, 0, 0, 1)";
export function prefersReducedMotion(): boolean {
	return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function cancelAnimation(animation: Animation | null) {
	if (!animation) return;
	// Layout changes deliberately cancel in-flight effects; their finished promise rejects on cancel.
	void animation.finished.catch(() => {});
	animation.cancel();
}

function cancelAnimations(
	height: { current: Animation | null },
	moves: Map<HTMLElement, Animation>,
	incoming: Set<Animation>,
	ordinary: Set<Animation>,
) {
	cancelAnimation(height.current);
	height.current = null;
	for (const animation of moves.values()) cancelAnimation(animation);
	moves.clear();
	for (const animation of incoming) cancelAnimation(animation);
	incoming.clear();
	for (const animation of ordinary) cancelAnimation(animation);
	ordinary.clear();
}

/**
 * FLIP 让位动画：容器内带 data-shift-key 的项增减时，让现有项从旧位置滑向新位置。
 * 不处理纯重排，拖拽在途用 skip；只用局部布局坐标，不把滚动当成位移。
 * 不用全页 View Transitions，避免根快照跨淡与流式正文/侧栏宽度过渡叠加而闪。
 * collapse 同时照顾列表高度/尾部，并在收拢完成后淡入补页项，避免新旧行交叠。
 */
export function useListShift({
	collapse = false,
	skip = false,
}: {
	collapse?: boolean;
	skip?: boolean;
} = {}): RefObject<HTMLDivElement | null> {
	const ref = useRef<HTMLDivElement>(null);
	const previous = useRef(new Map<string, Point>());
	const previousHeight = useRef(0);
	const heightAnimation = useRef<Animation | null>(null);
	const moves = useRef(new Map<HTMLElement, Animation>());
	const incoming = useRef(new Set<Animation>());
	const ordinary = useRef(new Set<Animation>());
	const settlingUntil = useRef(0);

	useLayoutEffect(() => {
		const container = ref.current;
		if (!container || skip || prefersReducedMotion()) {
			cancelAnimations(heightAnimation, moves.current, incoming.current, ordinary.current);
			previous.current.clear();
			previousHeight.current = 0;
			settlingUntil.current = 0;
			return;
		}
		const nodes = Array.from(container.querySelectorAll<HTMLElement>("[data-shift-key]"));
		const live = new Set(nodes);
		for (const [node, animation] of moves.current) {
			if (!live.has(node)) {
				cancelAnimation(animation);
				moves.current.delete(node);
			}
		}
		for (const animation of incoming.current) {
			const target = (animation.effect as KeyframeEffect | null)?.target;
			if (!target || !live.has(target as HTMLElement)) {
				cancelAnimation(animation);
				incoming.current.delete(animation);
			}
		}
		const next = new Map<string, Point>();
		for (const node of nodes) {
			const key = node.dataset.shiftKey;
			if (key)
				next.set(key, {
					x: node.offsetLeft,
					y: node.offsetTop,
					layoutOnly: node.hasAttribute("data-shift-layout-only"),
				});
		}
		const prev = previous.current;
		previous.current = next;
		// A footer disappearing on the final page is not a removed session.
		const removed = [...prev].some(([key, point]) => !next.has(key) && (!collapse || !point.layoutOnly));
		const changed = removed || [...next.keys()].some((key) => !prev.has(key));
		if (!changed || prev.size === 0) {
			if (!heightAnimation.current) previousHeight.current = container.offsetHeight;
			return;
		}

		const now = performance.now();
		// Progressive catalog pages replace keys while keeping their size: that is refresh, not deletion.
		const shrank =
			collapse &&
			removed &&
			[...next.values()].filter((point) => !point.layoutOnly).length <
				[...prev.values()].filter((point) => !point.layoutOnly).length;
		if (collapse && removed && !shrank) {
			// A refreshed page must not renew an earlier deletion's hidden phase.
			cancelAnimations(heightAnimation, moves.current, incoming.current, ordinary.current);
			settlingUntil.current = 0;
		}
		const collapsing = collapse && (shrank || now < settlingUntil.current);
		if (collapse && !collapsing) {
			previousHeight.current = container.offsetHeight;
			return;
		}
		if (collapsing) {
			const fromHeight = heightAnimation.current
				? container.getBoundingClientRect().height
				: previousHeight.current;
			cancelAnimation(heightAnimation.current);
			heightAnimation.current = null;
			const toHeight = container.offsetHeight;
			previousHeight.current = toHeight;
			settlingUntil.current = now + duration;
			if (fromHeight !== toHeight) {
				const animation = container.animate([{ height: `${fromHeight}px` }, { height: `${toHeight}px` }], {
					duration,
					easing,
				});
				heightAnimation.current = animation;
				animation.onfinish = () => {
					if (heightAnimation.current === animation) heightAnimation.current = null;
				};
			}
		}

		for (const node of nodes) {
			const key = node.dataset.shiftKey;
			const old = key ? prev.get(key) : undefined;
			const point = key ? next.get(key) : undefined;
			if (!point) continue;
			if (!old) {
				if (collapsing) {
					const animation = node.animate(
						[
							{ opacity: 0, visibility: "hidden" },
							{ opacity: 1, visibility: "visible" },
						],
						{
							duration: 100,
							delay: Math.max(0, settlingUntil.current - performance.now()),
							fill: "backwards",
						},
					);
					incoming.current.add(animation);
					animation.onfinish = () => incoming.current.delete(animation);
				} else if (!collapse) {
					const animation = node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 140, easing });
					ordinary.current.add(animation);
					animation.onfinish = () => ordinary.current.delete(animation);
				}
				continue;
			}
			let dx = old.x - point.x;
			let dy = old.y - point.y;
			if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
			if (collapse) {
				const active = moves.current.get(node);
				if (active) {
					const transform = getComputedStyle(node).transform;
					if (transform && transform !== "none") {
						const matrix = new DOMMatrixReadOnly(transform);
						dx += matrix.m41;
						dy += matrix.m42;
					}
					cancelAnimation(active);
					moves.current.delete(node);
				}
			}
			if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
			const animation = node.animate(
				[{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0px, 0px)" }],
				{ duration, easing },
			);
			if (collapse) {
				moves.current.set(node, animation);
				animation.onfinish = () => {
					if (moves.current.get(node) === animation) moves.current.delete(node);
				};
			} else {
				ordinary.current.add(animation);
				animation.onfinish = () => ordinary.current.delete(animation);
			}
		}
	});

	useLayoutEffect(() => {
		const animations = moves.current;
		const fades = incoming.current;
		const ordinaryAnimations = ordinary.current;
		return () => cancelAnimations(heightAnimation, animations, fades, ordinaryAnimations);
	}, []);
	return ref;
}
