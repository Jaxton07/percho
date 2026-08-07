/**
 * 活动预览调度：latest-wins + 最小停留合并（conflate）。
 * 预览行回答"agent 此刻在做什么"——永远显示最新一条活动；
 * 新活动在最小停留后立即上屏，停留期间到达的多条合并为最新一条。
 * 无队列、无失效校验：事件流是爆发的（pi 并行执行时 N 个工具瞬间到达），
 * FIFO 重播必然欠播/丢项，latest-wins 不会。
 */

export interface ActivitySlot {
	id: string;
	kind: "tool" | "thinking";
}

export interface ActivityTickerSnapshot {
	/** 当前应显示的活动 id；null = 无活动（UI 显示 fallback，如"思考中…"） */
	currentId: string | null;
	/** 计划切换时间戳（最小停留未到，到点后调 tick）；null = 无需定时 */
	switchAt: number | null;
}

export interface ActivityTicker {
	ingest(items: ActivitySlot[], now: number): ActivityTickerSnapshot;
	/** 到点切换：若最新活动仍未上屏则切到它（合并期间到达的多条） */
	tick(now: number): ActivityTickerSnapshot;
	peek(): ActivityTickerSnapshot;
}

export const ACTIVITY_TICKER_DEFAULTS = {
	/** 每条活动的最短停留时长：保证可读，又不会在爆发时积压 */
	minDwellMs: 350,
};

export function createActivityTicker(options: Partial<typeof ACTIVITY_TICKER_DEFAULTS> = {}): ActivityTicker {
	const { minDwellMs } = { ...ACTIVITY_TICKER_DEFAULTS, ...options };

	let currentId: string | null = null;
	let shownAt = 0;
	let latestItems: ActivitySlot[] = [];

	const snapshot = (switchAt: number | null): ActivityTickerSnapshot => ({ currentId, switchAt });

	const switchTo = (id: string, now: number): void => {
		currentId = id;
		shownAt = now;
	};

	const ingest = (items: ActivitySlot[], now: number): ActivityTickerSnapshot => {
		latestItems = items;
		const latest = items[items.length - 1];
		if (!latest) {
			// 活动清空（turn 提交后间隙）→ 回 fallback
			currentId = null;
			return snapshot(null);
		}
		if (latest.id === currentId) return snapshot(null);
		if (!currentId || now - shownAt >= minDwellMs) {
			switchTo(latest.id, now);
			return snapshot(null);
		}
		return snapshot(shownAt + minDwellMs);
	};

	const tick = (now: number): ActivityTickerSnapshot => {
		const latest = latestItems[latestItems.length - 1];
		if (latest && latest.id !== currentId) switchTo(latest.id, now);
		return snapshot(null);
	};

	return { ingest, tick, peek: () => snapshot(null) };
}
