import { type RefObject, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { RowPositions } from "./row-positions";

type SelectionKeys = { owner: RowPositions; anchor: string; focus: string };

/** Selection is a temporary constraint on the real row DOM, never a copy of its text. */
export function useNativeSelectionRange(
	contentRef: RefObject<HTMLDivElement | null>,
	positions: RowPositions,
) {
	const [keys, setKeys] = useState<SelectionKeys | null>(null);
	const stale = useRef<{
		anchor: Node | null;
		focus: Node | null;
		anchorOffset: number;
		focusOffset: number;
	} | null>(null);
	useLayoutEffect(() => {
		const content = contentRef.current;
		if (!content) return;
		let dragging = false;
		let origin: string | null = null;
		const rowKey = (node: Node | null): string | null => {
			if (!node || !content.contains(node)) return null;
			const element = node instanceof Element ? node : node.parentElement;
			const wrapper = element?.closest<HTMLElement>("[data-chat-row-key]");
			return wrapper?.parentElement === content ? (wrapper.dataset.chatRowKey ?? null) : null;
		};
		const update = (anchor: string | null, focus: string | null) => {
			const next =
				anchor && focus && positions.indexOfKey(anchor) >= 0 && positions.indexOfKey(focus) >= 0
					? { owner: positions, anchor, focus }
					: null;
			flushSync(() =>
				setKeys((previous) =>
					previous?.owner === next?.owner &&
					previous?.anchor === next?.anchor &&
					previous?.focus === next?.focus
						? previous
						: next,
				),
			);
		};
		const change = () => {
			const selection = document.getSelection();
			if (selection && stale.current) {
				const old = stale.current;
				if (
					selection.anchorNode === old.anchor &&
					selection.focusNode === old.focus &&
					selection.anchorOffset === old.anchorOffset &&
					selection.focusOffset === old.focusOffset
				)
					return;
				stale.current = null;
			}
			if (!selection || selection.isCollapsed) {
				update(dragging ? origin : null, dragging ? origin : null);
				return;
			}
			update(rowKey(selection.anchorNode), rowKey(selection.focusNode));
		};
		const down = (event: PointerEvent) => {
			if (event.button !== 0) return;
			stale.current = null;
			origin = rowKey(event.target as Node);
			dragging = origin !== null;
			if (origin) update(origin, origin);
		};
		const up = () => {
			if (!dragging) return;
			dragging = false;
			origin = null;
			change();
		};
		content.addEventListener("pointerdown", down);
		document.addEventListener("selectionchange", change);
		document.addEventListener("pointerup", up);
		document.addEventListener("pointercancel", up);
		return () => {
			const selection = document.getSelection();
			stale.current =
				selection && !selection.isCollapsed
					? {
							anchor: selection.anchorNode,
							focus: selection.focusNode,
							anchorOffset: selection.anchorOffset,
							focusOffset: selection.focusOffset,
						}
					: null;
			content.removeEventListener("pointerdown", down);
			document.removeEventListener("selectionchange", change);
			document.removeEventListener("pointerup", up);
			document.removeEventListener("pointercancel", up);
		};
	}, [contentRef, positions]);

	if (!keys || keys.owner !== positions) return null;
	const anchor = positions.indexOfKey(keys.anchor);
	const focus = positions.indexOfKey(keys.focus);
	return anchor < 0 || focus < 0
		? null
		: { start: Math.min(anchor, focus), end: Math.max(anchor, focus) + 1 };
}
