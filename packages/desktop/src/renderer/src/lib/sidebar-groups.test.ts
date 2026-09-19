import type { SessionMeta } from "@percho/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectEntry } from "../stores/projects";
import { setDailyDirForTest } from "./daily";
import {
	deriveSidebarGroups,
	PROJECTS_GROUP_KEY,
	type SidebarGroupsInput,
	toggleExpandedGroup,
	toggleInList,
} from "./sidebar-groups";

/**
 * 左侧栏派生层单测（纯函数，无 React/DOM）。日常目录是模块缓存 → 用 setDailyDirForTest 注入。
 * deriveProjects 的输出在测试里直接当 fixture 传进来（派生层只吃它的输出，不自己扫会话）。
 */

const DAILY = "/home/me/.percho/daily";
const P1 = "/work/alpha";
const P2 = "/work/beta";

setDailyDirForTest(DAILY);
afterEach(() => setDailyDirForTest(DAILY));

function session(id: string, cwd: string, modifiedAt: number, name = `会话 ${id}`): SessionMeta {
	return { sessionId: id, cwd, name, active: false, messageCount: 1, createdAt: 0, modifiedAt };
}

function project(cwd: string, addedIndex = -1, lastActive = 0, sessionCount = 0): ProjectEntry {
	return { cwd, name: cwd.split("/").pop() ?? cwd, sessionCount, lastActive, addedIndex };
}

function derive(overrides: Partial<SidebarGroupsInput> = {}) {
	return deriveSidebarGroups({
		sessions: [],
		projects: [],
		search: "",
		activeSessionId: null,
		pinnedSessions: [],
		pinnedProjects: [],
		expandedGroups: [],
		...overrides,
	});
}

describe("deriveSidebarGroups · 组内排序", () => {
	it("置顶会话在前，其余按最后活动倒序", () => {
		const result = derive({
			sessions: [
				session("a", P1, 100),
				session("b", P1, 300),
				session("c", P1, 200),
				session("d", DAILY, 50),
			],
			projects: [project(P1, 0)],
			pinnedSessions: ["a"],
		});
		const alpha = result.projects.find((p) => p.cwd === P1);
		expect(alpha?.sessions.map((s) => s.session.sessionId)).toEqual(["a", "b", "c"]);
		expect(alpha?.sessions.map((s) => s.pinned)).toEqual([true, false, false]);
		expect(alpha?.sessionCount).toBe(3);
	});
});

describe("deriveSidebarGroups · 项目区排序", () => {
	it("置顶项目按 pinnedProjects 顺序排前，其余保持 deriveProjects 的输出顺序", () => {
		const result = derive({
			projects: [project(P1, 1, 0, 3), project(P2, 0, 0, 5), project("/work/gamma", -1, 900, 1)],
			pinnedProjects: [P2],
		});
		expect(result.projects.map((p) => p.cwd)).toEqual([P2, P1, "/work/gamma"]);
		expect(result.projects.map((p) => p.pinned)).toEqual([true, false, false]);
		// totalSessions 取 deriveProjects 给的原始数（搜索过滤后也保持真实值，供移除确认文案用）
		expect(result.projects.map((p) => p.totalSessions)).toEqual([5, 3, 1]);
	});

	it("pinnedProjects 里的陌生 cwd 直接忽略", () => {
		const result = derive({ projects: [project(P1)], pinnedProjects: ["/gone", P1] });
		expect(result.projects.map((p) => p.cwd)).toEqual([P1]);
	});
});

describe("deriveSidebarGroups · 展开推断", () => {
	it("无用户记录：只展开当前会话所在组 + 项目小标", () => {
		const result = derive({
			sessions: [session("a", P1, 100), session("b", P2, 200), session("c", DAILY, 300)],
			projects: [project(P1), project(P2)],
			activeSessionId: "a",
		});
		expect(result.projects.map((p) => [p.cwd, p.expanded])).toEqual([
			[P1, true],
			[P2, false],
		]);
		expect(result.projectsExpanded).toBe(true);
		expect(result.daily?.expanded).toBe(false);
		expect(result.defaultExpandedKeys).toEqual([PROJECTS_GROUP_KEY, P1]);
	});

	it("有用户记录：完全以记录为准（当前组被折叠也尊重）", () => {
		const result = derive({
			sessions: [session("a", P1, 100), session("b", P2, 200)],
			projects: [project(P1), project(P2)],
			activeSessionId: "a",
			expandedGroups: [P2],
		});
		expect(result.projects.map((p) => [p.cwd, p.expanded])).toEqual([
			[P1, false],
			[P2, true],
		]);
		expect(result.projectsExpanded).toBe(false);
	});
});

describe("deriveSidebarGroups · 搜索过滤", () => {
	const sessions = [
		session("s1", P1, 100, "重构左侧栏"),
		session("s2", P1, 200, "修 mermaid"),
		session("s3", DAILY, 300, "闲聊"),
	];

	it("空 query 返回全量", () => {
		const result = derive({ sessions, projects: [project(P1)] });
		expect(result.daily?.sessionCount).toBe(1);
		expect(result.projects[0]?.sessionCount).toBe(2);
	});

	it("命中名称（大小写不敏感）", () => {
		const result = derive({ sessions, projects: [project(P1)], search: "MERMAID" });
		expect(result.projects[0]?.sessions.map((s) => s.session.sessionId)).toEqual(["s2"]);
		expect(result.daily).toBeNull();
	});

	it("命中 sessionId", () => {
		const result = derive({ sessions, projects: [project(P1)], search: "s3" });
		expect(result.daily?.sessions.map((s) => s.session.sessionId)).toEqual(["s3"]);
		expect(result.projects).toEqual([]);
	});
});

describe("deriveSidebarGroups · 日常组归属", () => {
	it("日常 cwd 的会话进日常组，不混进项目列表；未初始化的日常目录不产出日常组", () => {
		const result = derive({
			sessions: [session("a", DAILY, 100), session("b", P1, 200)],
			projects: [project(P1)],
		});
		expect(result.daily?.key).toBe(DAILY);
		expect(result.daily?.label).toBeNull();
		expect(result.daily?.kind).toBe("daily");
		expect(result.daily?.sessions.map((s) => s.session.sessionId)).toEqual(["a"]);
		expect(result.projects.map((p) => p.cwd)).toEqual([P1]);

		setDailyDirForTest(null);
		expect(derive({ sessions: [session("a", DAILY, 100)] }).daily).toBeNull();
	});
});

describe("toggleInList / toggleExpandedGroup", () => {
	it("置顶切换：新置顶排最前，取消则移除", () => {
		expect(toggleInList([], "a")).toEqual(["a"]);
		expect(toggleInList(["a"], "b")).toEqual(["b", "a"]);
		expect(toggleInList(["b", "a"], "a")).toEqual(["b"]);
	});

	it("展开切换：无记录时以默认集为起点翻转，不误伤其它组", () => {
		expect(toggleExpandedGroup([], P2, [PROJECTS_GROUP_KEY, P1])).toEqual([PROJECTS_GROUP_KEY, P1, P2]);
		expect(toggleExpandedGroup([PROJECTS_GROUP_KEY, P1], P1, [])).toEqual([PROJECTS_GROUP_KEY]);
		expect(toggleExpandedGroup([P1], P2, [P1])).toEqual([P1, P2]);
	});
});
