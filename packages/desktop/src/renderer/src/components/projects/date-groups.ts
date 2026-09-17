import type { SessionMeta } from "@percho/shared";

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

/** 项目页分组键：置顶组 + 三个日期组 */
export type SessionGroupKey = "pinned" | DateGroupKey;

export interface SessionGroup {
	key: SessionGroupKey;
	sessions: SessionMeta[];
}

/** 置顶组（恒在最前，空组剔除）+ 日期分组。入参已按置顶优先排序（deriveSessions） */
export function groupSessions(sessions: SessionMeta[], pinnedSessions: readonly string[]): SessionGroup[] {
	const pinned = new Set(pinnedSessions);
	const pinnedList = sessions.filter((s) => pinned.has(s.sessionId));
	const rest = sessions.filter((s) => !pinned.has(s.sessionId));
	return [
		...(pinnedList.length > 0 ? [{ key: "pinned" as const, sessions: pinnedList }] : []),
		...groupByDate(rest),
	];
}
