import { describe, expect, it } from "vitest";
import { type RowKind, RowPositions, type RowShape } from "./row-positions";

const row = (key: string, kind: RowKind = "other"): RowShape => ({ key, kind });

describe("RowPositions", () => {
	it("handles an empty list", () => {
		const positions = new RowPositions(8);
		expect(positions.count).toBe(0);
		expect(positions.total()).toBe(0);
		expect(positions.offsetOf(0)).toBe(0);
		expect(positions.indexAt(-1)).toBe(0);
		expect(positions.indexAt(0)).toBe(0);
	});

	it("computes offsets and total with a fixed gap", () => {
		const positions = new RowPositions(10);
		positions.sync([row("a"), row("b"), row("c")]);
		expect(positions.offsetOf(0)).toBe(0);
		expect(positions.offsetOf(1)).toBe(58);
		expect(positions.offsetOf(2)).toBe(116);
		expect(positions.offsetOf(3)).toBe(174);
		expect(positions.total()).toBe(164);
	});

	it("assigns exact boundaries to the next row and clamps outside values", () => {
		const positions = new RowPositions(10);
		positions.sync([row("a"), row("b"), row("c")]);
		expect(positions.indexAt(-0.01)).toBe(0);
		expect(positions.indexAt(0)).toBe(0);
		expect(positions.indexAt(57.99)).toBe(0);
		expect(positions.indexAt(58)).toBe(1);
		expect(positions.indexAt(116)).toBe(2);
		expect(positions.indexAt(positions.total())).toBe(2);
		expect(positions.indexAt(1000)).toBe(2);
	});

	it("returns height deltas and updates subsequent positions", () => {
		const positions = new RowPositions(8);
		positions.sync([row("a"), row("b"), row("c")]);
		expect(positions.setHeight("b", 100)).toBe(52);
		expect(positions.setHeight("b", 100)).toBe(0);
		expect(positions.heightOf(1)).toBe(100);
		expect(positions.offsetOf(2)).toBe(164);
		expect(positions.total()).toBe(212);
		expect(positions.isMeasured("b")).toBe(true);
		expect(positions.setHeight("missing", 10)).toBe(0);
	});

	it("reuses measurements across prepend but releases removed keys", () => {
		const positions = new RowPositions(6);
		positions.sync([row("a"), row("b")]);
		positions.setHeight("a", 90);
		positions.sync([row("new"), row("a"), row("b"), row("tail")]);
		expect(positions.indexOfKey("a")).toBe(1);
		expect(positions.heightOf(1)).toBe(90);
		expect(positions.isMeasured("a")).toBe(true);
		expect(positions.heightOf(0)).toBe(48);
		positions.sync([row("b"), row("tail")]);
		expect(positions.indexOfKey("a")).toBe(-1);
		positions.sync([row("a"), row("tail")]);
		expect(positions.heightOf(0)).toBe(48);
		expect(positions.isMeasured("a")).toBe(false);
	});

	it("keeps a key estimate frozen after the measured mean changes", () => {
		const positions = new RowPositions(0);
		positions.sync([row("first", "user")]);
		expect(positions.heightOf(0)).toBe(72);
		positions.setHeight("first", 100);
		positions.sync([row("first", "user")]);
		positions.sync([row("first", "user"), row("second", "user")]);
		expect(positions.heightOf(0)).toBe(100);
		expect(positions.heightOf(1)).toBe(72);
	});

	it("uses the measured running mean for new keys after three samples", () => {
		const positions = new RowPositions(0);
		positions.sync([row("a", "assistant"), row("b", "assistant"), row("c", "assistant")]);
		positions.setHeight("a", 100);
		positions.setHeight("b", 200);
		positions.setHeight("c", 300);
		positions.sync([
			row("a", "assistant"),
			row("b", "assistant"),
			row("c", "assistant"),
			row("d", "assistant"),
		]);
		expect(positions.heightOf(3)).toBe(200);
		positions.setHeight("a", 400);
		positions.sync([
			row("a", "assistant"),
			row("b", "assistant"),
			row("c", "assistant"),
			row("d", "assistant"),
			row("e", "assistant"),
		]);
		expect(positions.heightOf(3)).toBe(200);
		expect(positions.heightOf(4)).toBe(300);
	});

	it("supports negative heights down to negative gap", () => {
		const positions = new RowPositions(10);
		positions.sync([row("zero"), row("visible")]);
		expect(positions.setHeight("zero", -10)).toBe(-58);
		expect(positions.offsetOf(1)).toBe(0);
		expect(positions.setHeight("visible", -50)).toBe(-58);
		expect(positions.heightOf(1)).toBe(-10);
		expect(positions.total()).toBe(-10);
		expect(positions.indexAt(-1)).toBe(0);
		expect(positions.indexAt(0)).toBe(1);
	});

	it("does not change heights when syncing an identical key sequence", () => {
		const positions = new RowPositions(0);
		positions.sync([row("a", "user"), row("b", "user")]);
		positions.setHeight("a", 90);
		positions.sync([row("a", "user"), row("b", "user")]);
		positions.sync([row("a", "user"), row("b", "user"), row("c", "user")]);
		expect(positions.heightOf(2)).toBe(72);
	});

	it("invalidates measurements while retaining assigned estimates", () => {
		const positions = new RowPositions(4);
		positions.sync([row("a", "user"), row("b", "user"), row("c", "user"), row("d", "user")]);
		positions.setHeight("a", 100);
		positions.setHeight("b", 200);
		positions.setHeight("c", 300);
		positions.sync([
			row("a", "user"),
			row("b", "user"),
			row("c", "user"),
			row("d", "user"),
			row("e", "user"),
		]);
		expect(positions.heightOf(3)).toBe(72);
		expect(positions.heightOf(4)).toBe(200);
		positions.invalidateMeasurements();
		expect(positions.isMeasured("a")).toBe(false);
		expect(positions.isMeasured("b")).toBe(false);
		expect(positions.heightOf(0)).toBe(72);
		expect(positions.heightOf(1)).toBe(72);
		expect(positions.heightOf(2)).toBe(72);
		expect(positions.heightOf(3)).toBe(72);
		expect(positions.heightOf(4)).toBe(72);
	});

	it("matches a naive index and offset implementation for randomized rows and updates", () => {
		let seed = 123456789;
		const random = () => {
			seed = (seed * 1664525 + 1013904223) >>> 0;
			return seed / 0x100000000;
		};
		const gap = 7;
		const count = 2000;
		const positions = new RowPositions(gap);
		const heights = Array.from({ length: count }, () => Math.floor(random() * 120) - gap);
		const rows = heights.map((_, index) => row(`r${index}`));
		positions.sync(rows);
		for (const [index, height] of heights.entries()) positions.setHeight(`r${index}`, height);
		for (let update = 0; update < 300; update++) {
			const index = Math.floor(random() * count);
			const height = Math.floor(random() * 180) - gap;
			heights[index] = height;
			positions.setHeight(`r${index}`, height);
		}
		const extents = heights.map((height) => Math.max(0, height + gap));
		const naiveOffset = (index: number) => extents.slice(0, index).reduce((sum, value) => sum + value, 0);
		const naiveTotal = extents.reduce((sum, value) => sum + value, 0) - gap;
		const naiveIndexAt = (y: number) => {
			if (y < 0) return 0;
			if (y >= naiveTotal) return count - 1;
			let index = 0;
			while (index + 1 < count && naiveOffset(index + 1) <= y) index++;
			return index;
		};
		expect(positions.total()).toBe(naiveTotal);
		for (let index = 0; index <= count; index += 13)
			expect(positions.offsetOf(index)).toBe(naiveOffset(index));
		for (let sample = 0; sample < 500; sample++) {
			const y = random() * (naiveTotal + 40) - 20;
			expect(positions.indexAt(y)).toBe(naiveIndexAt(y));
		}
	});

	it("handles 5000 rows and 10000 random logarithmic updates and lookups quickly", () => {
		let seed = 987654321;
		const random = () => {
			seed = (seed * 1664525 + 1013904223) >>> 0;
			return seed / 0x100000000;
		};
		const positions = new RowPositions(8);
		positions.sync(Array.from({ length: 5000 }, (_, index) => row(`p${index}`)));
		const start = performance.now();
		for (let operation = 0; operation < 10_000; operation++) {
			const index = Math.floor(random() * positions.count);
			positions.setHeight(`p${index}`, 20 + random() * 200);
			positions.indexAt(random() * positions.total());
		}
		expect(performance.now() - start).toBeLessThan(100);
	});
});
