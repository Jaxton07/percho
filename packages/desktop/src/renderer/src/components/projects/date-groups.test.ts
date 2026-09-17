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

const now = Date.now();
const today = now - 60_000;
const yesterday = now - 30 * 60 * 60 * 1000;
const earlier = now - 5 * 24 * 60 * 60 * 1000;

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
