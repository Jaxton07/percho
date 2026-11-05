// @vitest-environment happy-dom
import { act, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { RowPositions } from "./row-positions";
import { useNativeSelectionRange } from "./use-native-selection-range";

it("retains real selected rows across window movement, releases on collapse and rejects old owners", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	let move!: (index: number) => void;
	function Probe({ session, generation = 0 }: { session: string; generation?: number }) {
		const content = useRef<HTMLDivElement>(null);
		const [top, setTop] = useState(0);
		move = setTop;
		// biome-ignore lint/correctness/useExhaustiveDependencies: session identifies the source installation
		const positions = useMemo(() => {
			const result = new RowPositions(0);
			result.sync(Array.from({ length: 200 }, (_, i) => ({ key: `row-${i}`, kind: "user" as const })));
			return result;
		}, [session, generation]);
		const selected = useNativeSelectionRange(content, positions);
		const start = Math.min(top, selected?.start ?? top);
		const end = Math.max(top + 10, selected?.end ?? top + 10);
		return (
			<div ref={content}>
				{Array.from({ length: end - start }, (_, n) => {
					const i = start + n;
					return (
						<div key={`${session}-${i}`} data-chat-row-key={`row-${i}`}>
							<p>{`${session}-${i}: ${"x".repeat(50)}`}</p>
						</div>
					);
				})}
			</div>
		);
	}
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const selection = document.getSelection();
	if (!selection) throw new Error("selection unavailable");
	const text = (i: number) => {
		const node = host.querySelector(`[data-chat-row-key="row-${i}"] p`)?.firstChild;
		if (!node) throw new Error(`missing row ${i}`);
		return node;
	};
	const change = () => document.dispatchEvent(new Event("selectionchange"));
	try {
		await act(() => root.render(<Probe session="A" />));
		const source = text(0);
		const range = document.createRange();
		range.setStart(source, 0);
		range.setEnd(source, 40);
		await act(() => {
			selection.removeAllRanges();
			selection.addRange(range);
			change();
		});
		await act(() => move(150));
		expect(source.isConnected).toBe(true);
		expect(selection.toString()).toHaveLength(40);
		expect(host.querySelectorAll("[data-chat-row-key]")).toHaveLength(160);
		await act(() => {
			selection.extend(text(155), 10);
			change();
		});
		await act(() => move(190));
		expect(host.querySelector('[data-chat-row-key="row-100"]')).not.toBeNull();
		expect(selection.toString()).toContain("A-100:");
		await act(() => {
			selection.collapse(source, 0);
			change();
		});
		expect(host.querySelectorAll("[data-chat-row-key]")).toHaveLength(10);
		await act(() => move(0));
		const dragSource = text(0);
		await act(() => {
			selection.collapse(dragSource, 0);
			dragSource.parentElement?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
		});
		await act(() => move(190));
		expect(dragSource.isConnected).toBe(true);
		await act(() => document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })));
		expect(host.querySelectorAll("[data-chat-row-key]")).toHaveLength(10);
		await act(() => move(0));
		const old = text(0);
		const oldRange = document.createRange();
		oldRange.setStart(old, 0);
		oldRange.setEnd(old, 40);
		await act(() => {
			selection.removeAllRanges();
			selection.addRange(oldRange);
			change();
		});
		await act(() => root.render(<Probe session="A" generation={1} />));
		await act(change);
		await act(() => move(190));
		expect(host.querySelectorAll("[data-chat-row-key]")).toHaveLength(10);
		await act(() => root.render(<Probe session="B" />));
		await act(() => move(190));
		await act(change);
		expect(host.querySelectorAll("[data-chat-row-key]")).toHaveLength(10);
	} finally {
		await act(() => {
			selection.removeAllRanges();
			root.unmount();
		});
		host.remove();
		vi.unstubAllGlobals();
	}
});
