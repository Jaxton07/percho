import { CHAT_COLUMN_DEFAULT_WIDTH, CHAT_COLUMN_MIN_WIDTH } from "@percho/shared";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { useUiPreferencesStore } from "../../stores/ui-preferences";

/** Mirrors the column's gutter without putting resize controls inside the scrolling transcript. */
export function ChatColumnResizeHandles({ empty = false }: { empty?: boolean }) {
	const t = useT();
	const value = useUiPreferencesStore((s) => s.chatColumnWidth);
	const layerRef = useRef<HTMLDivElement>(null);
	const [maximum, setMaximum] = useState(CHAT_COLUMN_DEFAULT_WIDTH);
	const [resizing, setResizing] = useState(false);
	const drag = useRef<{
		element: HTMLHRElement;
		pointerId: number;
		x: number;
		width: number;
		intent: number;
		side: number;
		cursor: string;
		userSelect: string;
	} | null>(null);

	const availableWidth = useCallback(() => {
		const layer = layerRef.current;
		if (!layer) return CHAT_COLUMN_DEFAULT_WIDTH;
		// The empty page keeps its existing 32px gutters and 40px wider composer.
		return Math.max(CHAT_COLUMN_MIN_WIDTH, layer.clientWidth - (empty ? 104 : 0));
	}, [empty]);

	useLayoutEffect(() => {
		const layer = layerRef.current;
		if (!layer) return;
		const measure = () => setMaximum(availableWidth());
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(layer);
		return () => observer.disconnect();
	}, [availableWidth]);

	const finish = useCallback((cancel = false) => {
		const current = drag.current;
		if (!current) return;
		drag.current = null;
		document.body.style.cursor = current.cursor;
		document.body.style.userSelect = current.userSelect;
		setResizing(false);
		const store = useUiPreferencesStore.getState();
		if (cancel) store.previewChatColumnWidth(current.intent);
		else if (store.chatColumnWidth !== current.intent) store.commitChatColumnWidth();
		if (current.element.hasPointerCapture(current.pointerId)) {
			current.element.releasePointerCapture(current.pointerId);
		}
	}, []);

	useEffect(() => {
		const stop = () => finish();
		const hide = () => {
			if (document.hidden) finish();
		};
		window.addEventListener("blur", stop);
		document.addEventListener("visibilitychange", hide);
		return () => {
			window.removeEventListener("blur", stop);
			document.removeEventListener("visibilitychange", hide);
			finish();
		};
	}, [finish]);

	const commit = (width: number) => {
		const store = useUiPreferencesStore.getState();
		store.previewChatColumnWidth(width);
		if (useUiPreferencesStore.getState().chatColumnWidth !== store.chatColumnWidth) {
			store.commitChatColumnWidth();
		}
	};

	return (
		<div
			ref={layerRef}
			className="chat-column-resize-layer"
			data-empty={empty || undefined}
			data-resizing={resizing || undefined}
		>
			<div className="chat-column-resize-frame">
				{([-1, 1] as const).map((side) => (
					<hr
						key={side}
						tabIndex={0}
						className="chat-column-resize-handle"
						data-side={side === -1 ? "left" : "right"}
						aria-orientation="vertical"
						aria-label={t(side === -1 ? "message.resizeColumnLeft" : "message.resizeColumnRight")}
						aria-valuemin={CHAT_COLUMN_MIN_WIDTH}
						aria-valuemax={maximum}
						aria-valuenow={Math.min(value, maximum)}
						title={t("message.resizeColumnHint")}
						onPointerDown={(event) => {
							if (event.button !== 0 || drag.current) return;
							const element = event.currentTarget;
							const intent = useUiPreferencesStore.getState().chatColumnWidth;
							drag.current = {
								element,
								pointerId: event.pointerId,
								x: event.clientX,
								width: Math.min(intent, availableWidth()),
								intent,
								side,
								cursor: document.body.style.cursor,
								userSelect: document.body.style.userSelect,
							};
							element.focus({ preventScroll: true });
							element.setPointerCapture(event.pointerId);
							document.body.style.cursor = "col-resize";
							document.body.style.userSelect = "none";
							setResizing(true);
							event.preventDefault();
						}}
						onPointerMove={(event) => {
							const current = drag.current;
							if (!current || event.pointerId !== current.pointerId) return;
							if (event.buttons === 0) return finish();
							const delta = event.clientX - current.x;
							if (delta === 0) {
								useUiPreferencesStore.getState().previewChatColumnWidth(current.intent);
								return;
							}
							useUiPreferencesStore
								.getState()
								.previewChatColumnWidth(Math.min(availableWidth(), current.width + delta * current.side * 2));
						}}
						onPointerUp={(event) => {
							if (event.pointerId === drag.current?.pointerId) finish();
						}}
						onPointerCancel={(event) => {
							if (event.pointerId === drag.current?.pointerId) finish(true);
						}}
						onLostPointerCapture={(event) => {
							if (event.pointerId === drag.current?.pointerId) finish();
						}}
						onDoubleClick={() => commit(CHAT_COLUMN_DEFAULT_WIDTH)}
						onKeyDown={(event) => {
							// Focused resize controls must not activate global permission shortcuts.
							event.stopPropagation();
							if (event.key === "Escape" && drag.current) {
								event.preventDefault();
								finish(true);
								return;
							}
							if (drag.current) return;
							if (event.key === "Enter" || event.key === "Home") {
								event.preventDefault();
								commit(CHAT_COLUMN_DEFAULT_WIDTH);
							} else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
								event.preventDefault();
								const delta = (event.key === "ArrowRight" ? 1 : -1) * side * (event.shiftKey ? 50 : 10);
								commit(Math.min(availableWidth(), Math.min(value, availableWidth()) + delta));
							}
						}}
					/>
				))}
			</div>
		</div>
	);
}
