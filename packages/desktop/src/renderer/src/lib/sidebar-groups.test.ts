import type { SessionMeta } from "@percho/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectEntry } from "../stores/projects";
import { deriveProjects } from "../stores/projects";
import { setDailyDirForTest } from "./daily";
import * as sidebarGroupsModule from "./sidebar-groups";
import {
	deriveSidebarGroups,
	mergeSidebarSessions,
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

/**
 * 阶段 0 红测（spec singleton-draft-subagent-nav §6.2）：`SidebarGroupsInput` 改为显式接收 `activeCwd`，
 * 不再从可见 sessions 反查 active id 得到 cwd（只读子会话被过滤掉后那条路会丢信息）。
 * 这里用交叉类型：阶段 2 实现后字段就是 SidebarGroupsInput 自己的字段，测试无需再改。
 */
type SidebarInput = SidebarGroupsInput & { activeCwd: string | null };

/**
 * 阶段 0 红测：`isPrimaryNavigationSession` 在阶段 2 落地。
 * 用命名空间取（缺失时为 undefined），避免「导入不存在的导出」导致整个文件挂掉。
 */
const isPrimaryNavigationSession = (
	sidebarGroupsModule as unknown as {
		isPrimaryNavigationSession?: (session: SessionMeta) => boolean;
	}
).isPrimaryNavigationSession as (session: SessionMeta) => boolean;

function session(id: string, cwd: string, modifiedAt: number, name = `会话 ${id}`): SessionMeta {
	return { sessionId: id, cwd, name, active: false, messageCount: 1, createdAt: 0, modifiedAt };
}

function project(cwd: string, addedIndex = -1, lastActive = 0, sessionCount = 0): ProjectEntry {
	return { cwd, name: cwd.split("/").pop() ?? cwd, sessionCount, lastActive, addedIndex };
}

function derive(overrides: Partial<SidebarInput> = {}) {
	return deriveWithTouched(overrides, false);
}

/**
 * 展开态「用户已操作」位：所有用例**显式给值**，不依赖实现里的缺省推断。
 * `activeCwd` 也显式给（阶段 0 起契约就是「调用方传当前会话所在目录」）。
 */
function deriveWithTouched(overrides: Partial<SidebarInput>, expandedGroupsTouched: boolean) {
	return deriveSidebarGroups({
		sessions: [],
		projects: [],
		search: "",
		activeSessionId: null,
		activeCwd: null,
		pinnedSessions: [],
		pinnedProjects: [],
		expandedGroups: [],
		...overrides,
		expandedGroupsTouched,
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
	it("无用户记录：只展开当前会话所在组（「项目」小标 v7 起不可折叠，不再进默认集）", () => {
		const result = derive({
			sessions: [session("a", P1, 100), session("b", P2, 200), session("c", DAILY, 300)],
			projects: [project(P1), project(P2)],
			activeSessionId: "a",
			activeCwd: P1,
		});
		expect(result.projects.map((p) => [p.cwd, p.expanded])).toEqual([
			[P1, true],
			[P2, false],
		]);
		expect(result.daily?.expanded).toBe(false);
		expect(result.defaultExpandedKeys).toEqual([P1]);
	});

	it("无当前会话：默认展开集为空（不会误展开任何组）", () => {
		const result = derive({ sessions: [session("a", P1, 100)], projects: [project(P1)] });
		expect(result.defaultExpandedKeys).toEqual([]);
		expect(result.projects.map((p) => p.expanded)).toEqual([false]);
	});

	it("有用户记录（touched=true）：完全以记录为准（当前组被折叠也尊重）", () => {
		const result = deriveWithTouched(
			{
				sessions: [session("a", P1, 100), session("b", P2, 200)],
				projects: [project(P1), project(P2)],
				activeSessionId: "a",
				expandedGroups: [P2],
			},
			true,
		);
		expect(result.projects.map((p) => [p.cwd, p.expanded])).toEqual([
			[P1, false],
			[P2, true],
		]);
	});

	it("历史遗留的 __projects__ 值不匹配任何组，不报错也不影响其它组（无需数据迁移）", () => {
		// 遗留非空记录 → 迁移推断为「用户操作过」（touched=true），但值本身不匹配任何组
		const result = deriveWithTouched(
			{
				sessions: [session("a", P1, 100)],
				projects: [project(P1)],
				activeSessionId: "a",
				expandedGroups: ["__projects__"],
			},
			true,
		);
		expect(result.projects.map((p) => p.expanded)).toEqual([false]);
	});
});

describe("deriveSidebarGroups · 展开状态 touched 位", () => {
	it("touched=false + 空记录：按默认推断只展开当前会话所在组", () => {
		const result = deriveWithTouched(
			{ sessions: [session("a", P1, 100)], projects: [project(P1)], activeSessionId: "a", activeCwd: P1 },
			false,
		);
		expect(result.projects.map((p) => [p.cwd, p.expanded])).toEqual([[P1, true]]);
	});

	it("touched=true + 空记录：空数组合法 = 全部折叠（不能再被当成「未操作」回退默认集）", () => {
		const result = deriveWithTouched(
			{ sessions: [session("a", P1, 100)], projects: [project(P1)], activeSessionId: "a", activeCwd: P1 },
			true,
		);
		expect(result.projects.map((p) => [p.cwd, p.expanded])).toEqual([[P1, false]]);
		// 默认集仍照常给出（供首次开合当起点），只是不再参与展开推断
		expect(result.defaultExpandedKeys).toEqual([P1]);
	});

	it("折叠最后一个展开组 → 再派生：保持全部折叠（切会话/重渲染不复活）", () => {
		const base = {
			sessions: [session("a", P1, 100)],
			projects: [project(P1)],
			activeSessionId: "a",
			activeCwd: P1,
		};
		const first = deriveWithTouched(base, false);
		expect(first.defaultExpandedKeys).toEqual([P1]);
		// 用户点当前项目：toggle 以默认集为起点翻转 → []（store 同时置 touched=true）
		const next = toggleExpandedGroup([], P1, first.defaultExpandedKeys);
		expect(next).toEqual([]);
		const second = deriveWithTouched({ ...base, expandedGroups: next }, true);
		expect(second.projects.map((p) => [p.cwd, p.expanded])).toEqual([[P1, false]]);
	});

	it("touched=true 时切换当前会话：不自动展开任何组（新当前组也保持折叠）", () => {
		const result = deriveWithTouched(
			{
				sessions: [session("a", P1, 100), session("b", P2, 200)],
				projects: [project(P1), project(P2)],
				activeSessionId: "b",
				expandedGroups: [],
			},
			true,
		);
		expect(result.projects.map((p) => [p.cwd, p.expanded])).toEqual([
			[P1, false],
			[P2, false],
		]);
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

describe("mergeSidebarSessions（磁盘历史 + 当前内存会话）", () => {
	const hist = [session("h1", P1, 100), session("h2", P1, 200)];

	it("内存项按 sessionId 覆盖历史项（改名/模型等以当前实例为准），不产生重复行", () => {
		const renamed = { ...session("h2", P1, 200), name: "改过的名字" };
		const merged = mergeSidebarSessions(hist, [renamed]);
		expect(merged.map((s) => s.sessionId)).toEqual(["h1", "h2"]);
		expect(merged.find((s) => s.sessionId === "h2")?.name).toBe("改过的名字");
	});

	it("内存独有项全部保留（刚创建还没进历史的真实会话），顺序不被改写", () => {
		const merged = mergeSidebarSessions(hist, [session("fresh-0", P1, 300), session("fresh", P1, 400)]);
		expect(merged.map((s) => s.sessionId)).toEqual(["h1", "h2", "fresh-0", "fresh"]);
	});

	it("无内存会话时等于历史（顺序不变）", () => {
		expect(mergeSidebarSessions(hist, []).map((s) => s.sessionId)).toEqual(["h1", "h2"]);
	});

	it("合并结果直接驱动派生：内存独有会话落在所属项目的分组里（cwd 尚无历史时也成组）", () => {
		const merged = mergeSidebarSessions(hist, [session("fresh-1", P2, 300)]);
		const result = derive({
			sessions: merged,
			projects: [project(P1), project(P2)],
			activeSessionId: "fresh-1",
			activeCwd: P2,
		});
		expect(result.projects.find((p) => p.cwd === P2)?.sessions.map((s) => s.session.sessionId)).toEqual([
			"fresh-1",
		]);
		expect(result.defaultExpandedKeys).toEqual([P2]);
	});
});

// ---------------------------------------------------------------------------
// 阶段 0 红测（spec sidebar-session-switch-stability D1 / §5 排序）：
// 内存 meta 覆盖历史 meta 时不得丢掉稳定时间字段，否则左栏排序键从 modifiedAt 掉到 createdAt、行跳动。
// 实现见 plan 阶段 1.2。
// ---------------------------------------------------------------------------

describe("mergeSidebarSessions · 稳定时间字段（打开/卸载不改变行位置）", () => {
	it("内存同 ID 缺 modifiedAt：保留历史活动时间；createdAt 用历史权威值（不信内存的运行态时间）", () => {
		const history: SessionMeta = { ...session("h1", P1, 900), createdAt: 100, messageCount: 3 };
		// 活跃会话 meta：registry 目前只给 createdAt（且是文件 birthtime），没有 modifiedAt
		const memory: SessionMeta = {
			sessionId: "h1",
			cwd: P1,
			active: true,
			messageCount: 5,
			createdAt: 5_000,
		};
		const merged = mergeSidebarSessions([history], [memory]);

		expect(merged).toHaveLength(1);
		expect(merged[0]?.modifiedAt).toBe(900);
		expect(merged[0]?.createdAt).toBe(100);
		// 运行态字段仍以内存为准
		expect(merged[0]?.messageCount).toBe(5);
		expect(merged[0]?.active).toBe(true);
	});

	it("内存给了 modifiedAt 就以内存的为准（会话真的产生了新活动）", () => {
		const merged = mergeSidebarSessions(
			[{ ...session("h1", P1, 900), createdAt: 100 }],
			[{ sessionId: "h1", cwd: P1, active: true, messageCount: 1, createdAt: 100, modifiedAt: 1_500 }],
		);
		expect(merged[0]?.modifiedAt).toBe(1_500);
	});

	it("打开前后派生顺序完全一致（点击历史行不再下移）", () => {
		const hist = [session("a", P1, 900), session("b", P1, 800), session("c", P1, 700)];
		const before = derive({ sessions: hist, projects: [project(P1)] });
		const orderBefore = before.projects[0]?.sessions.map((s) => s.session.sessionId);

		// 用户点了 b：b 变成「内存活跃会话」，内存 meta 无 modifiedAt（registry 现状）
		const merged = mergeSidebarSessions(hist, [
			{ sessionId: "b", cwd: P1, active: true, messageCount: 2, createdAt: 5_000 },
		]);
		const after = derive({ sessions: merged, projects: [project(P1)] });

		expect(orderBefore).toEqual(["a", "b", "c"]);
		expect(after.projects[0]?.sessions.map((s) => s.session.sessionId)).toEqual(orderBefore);
	});

	it("置顶分区顺序不受合并影响（置顶仍在最前，按 pinnedSessions 顺序）", () => {
		const hist = [session("a", P1, 900), session("b", P1, 800), session("c", P1, 700)];
		const merged = mergeSidebarSessions(hist, [
			{ sessionId: "c", cwd: P1, active: true, messageCount: 2, createdAt: 5_000 },
		]);
		const result = derive({ sessions: merged, projects: [project(P1)], pinnedSessions: ["c"] });
		const alpha = result.projects.find((p) => p.cwd === P1);
		expect(alpha?.sessions.map((s) => s.session.sessionId)).toEqual(["c", "a", "b"]);
		expect(alpha?.sessions.map((s) => s.pinned)).toEqual([true, false, false]);
	});

	it("无历史对应（同 ID 只出现在内存：刚创建的真实会话）时不做字段兜底，保持原样", () => {
		const fresh = session("fresh-2", P1, 300);
		expect(mergeSidebarSessions([session("h1", P1, 100)], [fresh])[1]).toBe(fresh);
	});
});

// ---------------------------------------------------------------------------
// 阶段 0 红测（spec singleton-draft-subagent-nav §6、plan 阶段 2）：
// 临时 subagent 检视会话只从**导航投影**过滤（内存 sessions / backend registry 不动），
// 过滤后的集合同时喂给 deriveProjects 与 deriveSidebarGroups；默认展开改用显式 activeCwd。
// ---------------------------------------------------------------------------

describe("导航投影：只读子会话不进左栏", () => {
	/**
	 * 与 Sidebar 的装配顺序一致：历史 + 内存合并 → 统一过滤 → 同一份集合喂给 deriveProjects
	 * 与 deriveSidebarGroups（阶段 2 实现；本用例同时钉住「计数/搜索/幽灵组同源」）。
	 */
	function navigation(history: SessionMeta[], memory: SessionMeta[], extra: Partial<SidebarInput> = {}) {
		const merged = mergeSidebarSessions(history, memory);
		const sessions = merged.filter((item) => isPrimaryNavigationSession(item));
		const projects = deriveProjects({ allSessions: sessions, addedProjects: [] });
		return { sessions, result: derive({ sessions, projects, ...extra }) };
	}

	it("isPrimaryNavigationSession：readOnly 子会话被排除，主会话保留", () => {
		expect(isPrimaryNavigationSession(session("main", P1, 100))).toBe(true);
		expect(isPrimaryNavigationSession({ ...session("sub", P1, 100), readOnly: true })).toBe(false);
	});

	it("只读子会话不计项目数量、不参与搜索、不生成幽灵项目组", () => {
		const sub = { ...session("sub-1", P2, 500, "子代理检视"), readOnly: true };
		const { sessions, result } = navigation([session("main", P1, 100)], [sub]);

		expect(sessions.map((s) => s.sessionId)).toEqual(["main"]);
		// P2 只有一条只读子会话：不该因此凭空长出一个项目组
		expect(result.projects.map((p) => p.cwd)).toEqual([P1]);
		expect(result.projects[0]?.totalSessions).toBe(1);

		const searched = navigation([session("main", P1, 100)], [sub], { search: "子代理" });
		expect(searched.result.projects).toEqual([]);
	});

	it("activeCwd 显式传入：active 会话本身被过滤出导航集合时仍能展开它所在项目（subagent 检视页）", () => {
		const sub = { ...session("sub-1", P2, 500), readOnly: true };
		const { result } = navigation([session("main", P1, 100)], [sub], {
			activeSessionId: "sub-1",
			activeCwd: P2,
		});
		expect(result.defaultExpandedKeys).toEqual([P2]);
		expect(result.projects.find((p) => p.cwd === P2)).toBeUndefined();
	});

	it("activeCwd 为 null（新会话 draft 页）：默认展开集为空，不误展开任何组", () => {
		const { result } = navigation([session("main", P1, 100)], [], {
			activeSessionId: null,
			activeCwd: null,
		});
		expect(result.defaultExpandedKeys).toEqual([]);
	});

	it("刚创建的普通真实会话仍由 mergeSidebarSessions 补进左栏（历史还没刷新的窗口）", () => {
		const fresh = { ...session("fresh-1", P2, 900), messageCount: 0 };
		const { result } = navigation([session("main", P1, 100)], [fresh], {});
		const beta = result.projects.find((p) => p.cwd === P2);
		expect(beta?.sessions.map((s) => s.session.sessionId)).toEqual(["fresh-1"]);
	});
});

describe("toggleInList / toggleExpandedGroup", () => {
	it("置顶切换：新置顶排最前，取消则移除", () => {
		expect(toggleInList([], "a")).toEqual(["a"]);
		expect(toggleInList(["a"], "b")).toEqual(["b", "a"]);
		expect(toggleInList(["b", "a"], "a")).toEqual(["b"]);
	});

	it("展开切换：无记录时以默认集为起点翻转，不误伤其它组", () => {
		expect(toggleExpandedGroup([], P2, [P1], false)).toEqual([P1, P2]);
		expect(toggleExpandedGroup([P1], P1, [], true)).toEqual([]);
		expect(toggleExpandedGroup([P1], P2, [P1], true)).toEqual([P1, P2]);
	});

	it("已操作过（touched=true）且记录为空（全部折叠）：再点一个组只展开它，不能回退默认集", () => {
		// 这是「折了最后一个组后又点开一个组」的场景：起点必须是空记录，否则会把当前会话所在组一起拉出来
		expect(toggleExpandedGroup([], P2, [P1], true)).toEqual([P2]);
	});
});
