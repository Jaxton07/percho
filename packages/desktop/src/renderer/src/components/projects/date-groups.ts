import type { SessionMeta } from "@pi-desktop/shared";

export type DateGroupKey = "today" | "yesterday" | "earlier";

export interface DateGroup {
	key: DateGroupKey;
	sessions: SessionMeta[];
}

/** 按今天/昨天/更早分组（固定顺序，空组剔除） */
export function groupByDate(sessions: SessionMeta[]): DateGroup[] {
	const now = new Date();
	const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
	const groups = new Map<DateGroupKey, SessionMeta[]>();
	for (const session of sessions) {
		const time = session.modifiedAt ?? session.createdAt;
		const key = time >= startOfToday ? "today" : time >= startOfYesterday ? "yesterday" : "earlier";
		const list = groups.get(key) ?? [];
		list.push(session);
		groups.set(key, list);
	}
	const order = ["today", "yesterday", "earlier"] as const;
	return order.filter((key) => groups.has(key)).map((key) => ({ key, sessions: groups.get(key) ?? [] }));
}
