import type { SessionMeta } from "@percho/shared";
import { describe, expect, it } from "vitest";
import { groupByDate, groupSessions } from "./date-groups";

function session(sessionId: string, modifiedAt: number): SessionMeta {
	return {
		sessionId,
		cwd: "/p",
		createdAt: modifiedAt,
		modifiedAt,
		active: false,
		messageCount: 0,
	};
}

// 分组边界是「本地零点」，fixture 也锚到本地零点：早先用 now - 30h 这类相对量，本地时间
// 不足 6 点时「昨天」会落到前天（CI 跑在 UTC 凌晨必挂：01:19 UTC 实测 3 条红）。
const startOfToday = new Date();
startOfToday.setHours(0, 0, 0, 0);
const base = startOfToday.getTime();
const today = base + 60_000; // 今天 00:01
const yesterday = base - 60_000; // 昨天 23:59
const earlier = base - 5 * 24 * 60 * 60 * 1000; // 5 天前

describe("groupByDate", () => {
	it("按今天/昨天/更早分组且空组剔除", () => {
		const groups = groupByDate([session("a", today), session("c", earlier)]);
		expect(groups.map((g) => g.key)).toEqual(["today", "earlier"]);
		expect(groups[0]?.sessions.map((s) => s.sessionId)).toEqual(["a"]);
	});
});

describe("groupSessions", () => {
	const list = [
		session("pin1", earlier),
		session("pin2", earlier),
		session("a", today),
		session("b", yesterday),
	];

	it("置顶组恒在最前，其余进日期组", () => {
		const groups = groupSessions(list, ["pin1", "pin2"]);
		expect(groups.map((g) => g.key)).toEqual(["pinned", "today", "yesterday"]);
		expect(groups[0]?.sessions.map((s) => s.sessionId)).toEqual(["pin1", "pin2"]);
		expect(groups[1]?.sessions.map((s) => s.sessionId)).toEqual(["a"]);
	});

	it("无置顶时与纯日期分组一致（置顶组不出现）", () => {
		expect(groupSessions(list, []).map((g) => g.key)).toEqual(["today", "yesterday", "earlier"]);
	});

	it("置顶 id 不在列表里（已删除/别的项目）不生成空组", () => {
		expect(groupSessions(list, ["ghost"]).map((g) => g.key)).toEqual(["today", "yesterday", "earlier"]);
	});
});
