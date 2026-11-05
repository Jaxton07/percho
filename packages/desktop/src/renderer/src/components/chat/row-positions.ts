export type RowKind = "user" | "assistant" | "metaGroup" | "turnDiff" | "other";

export interface RowShape {
	key: string;
	kind: RowKind;
}

/** Default estimated margin-box heights, in pixels, by row kind. */
export const DEFAULT_ESTIMATES: Readonly<Record<RowKind, number>> = {
	user: 72,
	assistant: 220,
	metaGroup: 40,
	turnDiff: 36,
	other: 48,
};

interface CachedHeight {
	kind: RowKind;
	estimate: number;
	height: number;
	measured: boolean;
}

/** Maintains keyed row heights and their prefix positions in logarithmic time. */
export class RowPositions {
	private readonly gap: number;
	private readonly estimates: Record<RowKind, number>;
	private rows: RowShape[] = [];
	private heights: number[] = [];
	private tree: number[] = [0];
	private indices = new Map<string, number>();
	private readonly cache = new Map<string, CachedHeight>();
	private readonly measuredSums: Record<RowKind, number> = {
		user: 0,
		assistant: 0,
		metaGroup: 0,
		turnDiff: 0,
		other: 0,
	};
	private readonly measuredCounts: Record<RowKind, number> = {
		user: 0,
		assistant: 0,
		metaGroup: 0,
		turnDiff: 0,
		other: 0,
	};

	constructor(gap: number, estimates?: Partial<Record<RowKind, number>>) {
		this.gap = gap;
		this.estimates = { ...DEFAULT_ESTIMATES, ...estimates };
	}

	/** Replace row order, retaining each known key's frozen estimate or measurement. */
	sync(rows: readonly RowShape[]): void {
		if (rows.length === this.rows.length) {
			let identical = true;
			for (let i = 0; i < rows.length; i++) {
				if (rows[i]!.key !== this.rows[i]!.key || rows[i]!.kind !== this.rows[i]!.kind) {
					identical = false;
					break;
				}
			}
			if (identical) return;
		}
		const nextRows = rows.map(({ key, kind }) => ({ key, kind }));
		const nextHeights = new Array<number>(nextRows.length);
		const nextIndices = new Map<string, number>();
		for (let i = 0; i < nextRows.length; i++) {
			const row = nextRows[i]!;
			let cached = this.cache.get(row.key);
			if (!cached) {
				const count = this.measuredCounts[row.kind];
				const estimate = count >= 3 ? this.measuredSums[row.kind] / count : this.estimates[row.kind];
				cached = {
					kind: row.kind,
					estimate: this.clampHeight(estimate),
					height: this.clampHeight(estimate),
					measured: false,
				};
				this.cache.set(row.key, cached);
			} else if (cached.kind !== row.kind) {
				if (cached.measured) {
					this.measuredSums[cached.kind] -= cached.height;
					this.measuredCounts[cached.kind]--;
				}
				cached.kind = row.kind;
				cached.estimate = this.estimates[row.kind];
				cached.height = cached.estimate;
				cached.measured = false;
			}
			nextHeights[i] = cached.height;
			nextIndices.set(row.key, i);
		}
		for (const [key, cached] of this.cache) {
			if (nextIndices.has(key)) continue;
			if (cached.measured) {
				this.measuredSums[cached.kind] -= cached.height;
				this.measuredCounts[cached.kind]--;
			}
			this.cache.delete(key);
		}
		this.rows = nextRows;
		this.heights = nextHeights;
		this.indices = nextIndices;
		this.rebuildTree();
	}

	/** Record a measured margin-box height and return its change from before. */
	setHeight(key: string, height: number): number {
		const index = this.indices.get(key);
		if (index === undefined) return 0;
		const cached = this.cache.get(key);
		if (!cached) return 0;
		const oldHeight = this.heights[index]!;
		const nextHeight = this.clampHeight(height);
		const delta = nextHeight - oldHeight;
		cached.height = nextHeight;
		if (cached.measured) {
			this.measuredSums[cached.kind] += nextHeight - oldHeight;
		} else {
			this.measuredSums[cached.kind] += nextHeight;
			this.measuredCounts[cached.kind]++;
		}
		cached.measured = true;
		this.heights[index] = nextHeight;
		this.add(index, nextHeight - oldHeight);
		return delta;
	}

	/** Return whether the key currently has a measured height. */
	isMeasured(key: string): boolean {
		return this.cache.get(key)?.measured ?? false;
	}
	/** Number of rows in the current order. */
	get count(): number {
		return this.rows.length;
	}
	/** Find a current row index by key, or -1 when absent. */
	indexOfKey(key: string): number {
		return this.indices.get(key) ?? -1;
	}
	/** Return the stored height at an index, or zero outside the list. */
	heightOf(index: number): number {
		return this.heights[index] ?? 0;
	}
	/** Return the top offset of a row, or the end offset at count. */
	offsetOf(index: number): number {
		return this.prefixSum(Math.max(0, Math.min(this.rows.length, Math.trunc(index))));
	}
	/** Return total row heights plus the gaps between rows. */
	total(): number {
		return this.rows.length === 0 ? 0 : this.prefixSum(this.rows.length) - this.gap;
	}

	/** Find the row containing y, respecting half-open row boundaries. */
	indexAt(y: number): number {
		const count = this.rows.length;
		if (count === 0 || y < 0) return 0;
		if (y >= this.total()) return count - 1;
		let index = 0;
		let prefix = 0;
		let step = 1;
		while (step * 2 <= count) step *= 2;
		for (; step > 0; step = Math.floor(step / 2)) {
			const candidate = index + step;
			if (candidate <= count && prefix + this.tree[candidate]! <= y) {
				index = candidate;
				prefix += this.tree[candidate]!;
			}
		}
		return Math.min(index, count - 1);
	}

	/** Forget measurements and restore each key's assigned estimate. */
	invalidateMeasurements(): void {
		for (const kind of Object.keys(this.measuredSums) as RowKind[]) {
			this.measuredSums[kind] = 0;
			this.measuredCounts[kind] = 0;
		}
		for (const cached of this.cache.values()) {
			cached.estimate = this.estimates[cached.kind];
			cached.height = cached.estimate;
			cached.measured = false;
		}
		for (let i = 0; i < this.rows.length; i++)
			this.heights[i] = this.cache.get(this.rows[i]!.key)?.estimate ?? this.heights[i]!;
		this.rebuildTree();
	}

	private clampHeight(height: number): number {
		return Math.max(height, -this.gap);
	}

	private rebuildTree(): void {
		const count = this.heights.length;
		this.tree = new Array<number>(count + 1).fill(0);
		for (let i = 1; i <= count; i++) {
			this.tree[i] = (this.tree[i] ?? 0) + Math.max(0, this.heights[i - 1]! + this.gap);
			const parent = i + (i & -i);
			if (parent <= count) this.tree[parent] = (this.tree[parent] ?? 0) + this.tree[i]!;
		}
	}

	private add(index: number, heightDelta: number): void {
		const oldHeight = this.heights[index]! - heightDelta;
		const extentDelta = Math.max(0, this.heights[index]! + this.gap) - Math.max(0, oldHeight + this.gap);
		for (let i = index + 1; i < this.tree.length; i += i & -i)
			this.tree[i] = (this.tree[i] ?? 0) + extentDelta;
	}

	private prefixSum(count: number): number {
		let sum = 0;
		for (let i = count; i > 0; i -= i & -i) sum += this.tree[i]!;
		return sum;
	}
}
