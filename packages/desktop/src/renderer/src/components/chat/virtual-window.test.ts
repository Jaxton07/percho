import { describe, expect, it } from "vitest";
import { RowPositions } from "./row-positions";
import { MAX_RENDERED_ROWS, OVERSCAN_PX, windowFor } from "./virtual-window";

function positions(count: number, height = 100) {
	const p = new RowPositions(16);
	p.sync(Array.from({ length: count }, (_, i) => ({ key: `r${i}`, kind: "assistant" as const })));
	for (let i = 0; i < count; i++) p.setHeight(`r${i}`, height);
	return p;
}

describe("windowFor", () => {
	it("empty list renders nothing", () => {
		expect(windowFor(new RowPositions(16), 0, 800, false)).toEqual({ start: 0, end: 0 });
	});

	it("covers the viewport plus overscan on both sides", () => {
		const p = positions(1000);
		const top = 50_000;
		const { start, end } = windowFor(p, top, 800, false);
		expect(p.offsetOf(start)).toBeLessThanOrEqual(top - OVERSCAN_PX + 116);
		expect(p.offsetOf(end)).toBeGreaterThanOrEqual(top + 800 + OVERSCAN_PX - 116);
		expect(end - start).toBeLessThanOrEqual(MAX_RENDERED_ROWS);
	});

	it("following pins the tail", () => {
		const p = positions(1000);
		expect(windowFor(p, 0, 800, true).end).toBe(1000);
	});

	it("caps row count even with tiny rows, keeping the viewport rows", () => {
		const p = positions(5000, 1);
		const top = 20_000;
		const { start, end } = windowFor(p, top, 800, false);
		expect(end - start).toBe(MAX_RENDERED_ROWS);
		const first = p.indexAt(top);
		expect(start).toBeLessThanOrEqual(first);
		expect(end).toBeGreaterThan(first);
	});

	it("covers all visible rows beyond the budget and retains the following tail", () => {
		const p = new RowPositions(0);
		p.sync(Array.from({ length: 5000 }, (_, i) => ({ key: `r${i}`, kind: "other" as const })));
		for (let i = 0; i < 5000; i++) p.setHeight(`r${i}`, 1);
		for (const following of [false, true]) {
			const top = following ? 4000 : 1700;
			const result = windowFor(p, top, 1000, following);
			expect(result.start).toBeLessThanOrEqual(p.indexAt(top));
			expect(result.end).toBeGreaterThan(p.indexAt(top + 999));
			if (following) expect(result.end).toBe(p.count);
		}
	});

	it("short list renders everything", () => {
		const p = positions(5);
		expect(windowFor(p, 0, 800, false)).toEqual({ start: 0, end: 5 });
	});
});
