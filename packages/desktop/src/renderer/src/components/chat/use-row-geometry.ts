import { type RefObject, useLayoutEffect, useRef } from "react";
import type { RowPositions } from "./row-positions";

export function restoreRowAnchor(
	content: HTMLElement | null,
	scroll: HTMLElement | null,
	anchor: { key: string; top: number } | null,
) {
	if (!content || !scroll || !anchor) return;
	const node = content.querySelector(
		`:scope > [data-chat-row-key="${CSS.escape(anchor.key)}"]`,
	)?.firstElementChild;
	if (node)
		scroll.scrollTop += node.getBoundingClientRect().top - scroll.getBoundingClientRect().top - anchor.top;
}

/** Owns observers and their targets together; no state is attached to React-managed DOM. */
export function useRowGeometry(
	contentRef: RefObject<HTMLDivElement | null>,
	scrollRef: RefObject<HTMLDivElement | null>,
	positions: RowPositions,
	version: string,
	rows: unknown,
	start: number,
	end: number,
	layoutTick: number,
	following: boolean,
	onChange: () => void,
	onResize: () => void,
	pinAnchor?: (key: string | null) => void,
	canAnchor?: () => boolean,
) {
	const callbacks = useRef({ onChange, onResize, following, pinAnchor, canAnchor });
	callbacks.current = { onChange, onResize, following, pinAnchor, canAnchor };
	const observerRef = useRef<ResizeObserver | null>(null);
	const targets = useRef(new Set<Element>());
	const anchor = useRef<{ key: string; top: number } | null>(null);
	const pendingScrollTop = useRef<number | null>(null);
	const stable = useRef<{ key: string; top: number; height: number; scrollTop: number } | null>(null);
	const snapshotRef = useRef<(() => void) | null>(null);
	const invalidateRef = useRef<(() => void) | null>(null);
	const versionRef = useRef(version);

	useLayoutEffect(() => {
		const content = contentRef.current;
		const scroll = scrollRef.current;
		if (!content || !scroll) return;
		let live = true;
		let frame = 0;
		let width = content.clientWidth;
		const mayAnchor = () => !callbacks.current.following && (callbacks.current.canAnchor?.() ?? true);
		const clearAnchor = (notify: boolean) => {
			if (!anchor.current) return;
			anchor.current = null;
			pendingScrollTop.current = null;
			callbacks.current.pinAnchor?.(null);
			if (notify) callbacks.current.onChange();
		};
		const snapshot = () => {
			stable.current = null;
			if (!mayAnchor() || anchor.current) return;
			const box = scroll.getBoundingClientRect();
			for (const wrapper of content.querySelectorAll<HTMLElement>(":scope > [data-chat-row-key]")) {
				const rect = wrapper.firstElementChild?.getBoundingClientRect();
				const key = wrapper.dataset.chatRowKey;
				if (key && rect && rect.height > 0 && rect.bottom > box.top && rect.top < box.bottom) {
					stable.current = { key, top: rect.top - box.top, height: rect.height, scrollTop: scroll.scrollTop };
					break;
				}
			}
		};
		snapshotRef.current = snapshot;
		const onScroll = () => {
			if (
				anchor.current &&
				pendingScrollTop.current !== null &&
				Math.abs(scroll.scrollTop - pendingScrollTop.current) > 1
			) {
				clearAnchor(true);
			}
			snapshot();
		};
		scroll.addEventListener("scroll", onScroll);
		const measure = (target: Element) => {
			const wrapper = target.parentElement;
			const key = wrapper?.dataset.chatRowKey;
			if (!key || !target.isConnected) return false;
			const style = getComputedStyle(target);
			const height =
				target.getBoundingClientRect().height +
				Number.parseFloat(style.marginTop) +
				Number.parseFloat(style.marginBottom);
			return Number.isFinite(height) && positions.setHeight(key, height) !== 0;
		};
		const rowsObserver = new ResizeObserver((entries) => {
			if (!live) return;
			let changed = false;
			for (const entry of entries) {
				if (!targets.current.has(entry.target)) continue;
				if (measure(entry.target)) changed = true;
			}
			if (changed) callbacks.current.onChange();
		});
		observerRef.current = rowsObserver;
		const invalidate = () => {
			const box = scroll.getBoundingClientRect();
			const saved = stable.current;
			const top = saved ? saved.top + saved.scrollTop - scroll.scrollTop : 0;
			if (mayAnchor() && anchor.current) {
				// Keep an in-flight restoration through consecutive invalidations.
			} else if (
				mayAnchor() &&
				saved &&
				positions.indexOfKey(saved.key) >= 0 &&
				top < box.height &&
				top + saved.height > 0
			) {
				anchor.current = { key: saved.key, top };
			} else {
				clearAnchor(false);
				snapshot();
				if (stable.current) anchor.current = { key: stable.current.key, top: stable.current.top };
			}
			callbacks.current.pinAnchor?.(anchor.current?.key ?? null);
			stable.current = null;
			const index = anchor.current ? positions.indexOfKey(anchor.current.key) : -1;
			const oldOffset = index >= 0 ? positions.offsetOf(index) : 0;
			positions.invalidateMeasurements();
			for (const target of targets.current) measure(target);
			if (index >= 0) scroll.scrollTop += positions.offsetOf(index) - oldOffset;
			pendingScrollTop.current = anchor.current ? scroll.scrollTop : null;
			// Refresh the caller's viewport before it computes a window from the new prefixes.
			callbacks.current.onResize();
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				frame = 0;
				if (live) callbacks.current.onChange();
			});
		};
		invalidateRef.current = invalidate;
		const resizeObserver = new ResizeObserver(() => {
			if (!live) return;
			const nextWidth = content.clientWidth;
			if (width !== nextWidth) {
				width = nextWidth;
				invalidate();
			} else callbacks.current.onResize();
		});
		resizeObserver.observe(content);
		resizeObserver.observe(scroll);
		return () => {
			live = false;
			cancelAnimationFrame(frame);
			scroll.removeEventListener("scroll", onScroll);
			rowsObserver.disconnect();
			resizeObserver.disconnect();
			targets.current.clear();
			observerRef.current = null;
			invalidateRef.current = null;
			snapshotRef.current = null;
			clearAnchor(false);
			stable.current = null;
		};
	}, [contentRef, scrollRef, positions]);

	// Reconcile targets after a window or row change, and restore a pending layout anchor.
	// biome-ignore lint/correctness/useExhaustiveDependencies: rows and window identify the rendered DOM
	useLayoutEffect(() => {
		const observer = observerRef.current;
		const content = contentRef.current;
		if (!observer || !content) return;
		const next = new Set(
			Array.from(
				content.querySelectorAll(":scope > [data-chat-row-key]"),
				(wrapper) => wrapper.firstElementChild,
			).filter((child): child is Element => child !== null),
		);
		for (const target of targets.current) if (!next.has(target)) observer.unobserve(target);
		for (const target of next) if (!targets.current.has(target)) observer.observe(target);
		targets.current = next;
		if (versionRef.current !== version) {
			versionRef.current = version;
			invalidateRef.current?.();
			return;
		}
		const saved = anchor.current;
		if (saved) {
			if (!following && (callbacks.current.canAnchor?.() ?? true))
				restoreRowAnchor(content, scrollRef.current, saved);
			anchor.current = null;
			pendingScrollTop.current = null;
			callbacks.current.pinAnchor?.(null);
			callbacks.current.onChange();
		}
		snapshotRef.current?.();
	}, [contentRef, scrollRef, positions, version, rows, start, end, layoutTick, following]);
}
