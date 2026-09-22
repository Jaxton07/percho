import type { SessionMeta } from "@percho/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** window.pi 的 mock：store 的 load 经 getPi() 访问（测试环境无 preload 注入） */
const piMock = vi.hoisted(() => ({
	listAllSessions: vi.fn(),
	getDailyDir: vi.fn(() => Promise.resolve(null)),
}));
vi.mock("../api", () => ({ getPi: () => piMock }));

import { setDailyDirForTest } from "../lib/daily";
import { deriveSidebarNavigation } from "../lib/sidebar-groups";
import { deriveProjects, useProjectsStore } from "./projects";
import { useSessionsStore } from "./sessions";

function session(cwd: string, modifiedAt: number): SessionMeta {
	return {
		sessionId: `${cwd}-${modifiedAt}`,
		cwd,
		name: "s",
		createdAt: modifiedAt,
		modifiedAt,
		sessionFile: "",
		active: false,
		messageCount: 0,
	};
}

const DAILY = "/Users/test/.percho/daily";

describe("deriveProjects", () => {
	it("手动添加的按添加时间倒排（最新在前）", () => {
		const addedProjects = ["/a", "/b", "/c"];
		const out = deriveProjects({ allSessions: [], addedProjects });
		expect(out.map((p) => p.cwd)).toEqual(["/c", "/b", "/a"]);
		expect(out.map((p) => p.addedIndex)).toEqual([2, 1, 0]);
	});
	it("未手动添加的历史会话项目排在添加项之后，按最后活动倒序", () => {
		const addedProjects = ["/b"];
		const allSessions = [session("/a", 100), session("/c", 300), session("/b", 200)];
		const out = deriveProjects({ allSessions, addedProjects });
		expect(out.map((p) => p.cwd)).toEqual(["/b", "/c", "/a"]);
	});
	it("删除后再次添加的项目排到最新", () => {
		const out = deriveProjects({ allSessions: [], addedProjects: ["/b", "/a", "/b"] });
		expect(out.map((p) => p.cwd)).toEqual(["/b", "/a"]);
	});
	it("会话项目与添加项合并：已有条目补 addedIndex", () => {
		const addedProjects = ["/a", "/b"];
		const allSessions = [session("/a", 100), session("/c", 400)];
		const out = deriveProjects({ allSessions, addedProjects });
		expect(out.map((p) => p.cwd)).toEqual(["/b", "/a", "/c"]);
	});
});

describe("deriveProjects · 日常空间隔离", () => {
	afterEach(() => setDailyDirForTest(null));

	it("日常目录的会话不生成项目条目", () => {
		setDailyDirForTest(DAILY);
		const out = deriveProjects({ allSessions: [session(DAILY, 100), session("/a", 300)], addedProjects: [] });
		expect(out.map((p) => p.cwd)).toEqual(["/a"]);
	});
	it("日常目录被手动添加过也不生成项目条目", () => {
		setDailyDirForTest(DAILY);
		const out = deriveProjects({ allSessions: [], addedProjects: [DAILY, "/a"] });
		expect(out.map((p) => p.cwd)).toEqual(["/a"]);
	});
	it("日常目录未初始化（null）时不过滤任何项目", () => {
		const out = deriveProjects({ allSessions: [session(DAILY, 100), session("/a", 300)], addedProjects: [] });
		expect(out).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// 阶段 0 红测（spec sidebar-session-switch-stability D6、§5 项目 load）：
// 列表刷新 latest-wins —— 旧 load 响应（成功或失败）不得覆盖更新响应，也不得提前把 loading 置 false。
// 实现见 plan 阶段 3.3。
// ---------------------------------------------------------------------------

/** 手写 deferred：要精确控制两次 load 的返回顺序（旧后到 / 旧失败后到） */
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function ids(): string[] {
	return useProjectsStore.getState().allSessions.map((s) => s.sessionId);
}

/**
 * 会话目录写穿（2026-09-21 事故修复）：
 * 「左栏/顶栏行存在不存在」必须由目录 `allSessions` 决定，内存 `sessions` 只管运行态。
 * 事故链路：磁盘历史只在进新会话页时整表重拉（是旧账，必然早于新建出来的会话）→ 新会话只活在内存里 →
 * 内存策略（GC）卸载它 → 内存没了、旧账里也没有 → 行凭空消失；点「＋」重拉一次才回来。
 */
describe("会话目录写穿（存在性只依赖目录）", () => {
	function freshMeta(id: string, cwd: string): SessionMeta {
		// 后端 createSession 刚返回的 meta（0 消息：会话文件还没落盘，但路径已定）
		return {
			sessionId: id,
			cwd,
			name: "新会话",
			sessionFile: `${cwd}/${id}.jsonl`,
			active: true,
			messageCount: 0,
			createdAt: 500,
			modifiedAt: 500,
		};
	}

	beforeEach(() => {
		vi.clearAllMocks();
		useProjectsStore.setState({ allSessions: [], selectedCwd: null, search: "" });
		useSessionsStore.setState({ sessions: [], activeSessionId: null, cwd: null });
	});

	it("会话一进内存（新建/打开）就写进目录 —— 哪怕磁盘快照比它更旧", () => {
		useProjectsStore.setState({ allSessions: [session("/p", 100)] });
		useSessionsStore.setState({ sessions: [freshMeta("new-1", "/p")] });
		expect(ids()).toEqual(["/p-100", "new-1"]);
	});

	it("只补缺：磁盘已有的同 id 项不被内存 meta 覆盖（时间字段仍是磁盘权威值）", () => {
		useProjectsStore.setState({ allSessions: [session("/p", 100)] });
		const sameId = { ...freshMeta("/p-100", "/p"), createdAt: 999, modifiedAt: 999, name: "内存名" };
		useSessionsStore.setState({ sessions: [sameId] });
		expect(useProjectsStore.getState().allSessions).toHaveLength(1);
		expect(useProjectsStore.getState().allSessions[0]?.modifiedAt).toBe(100);
	});

	it("全量对账（load）不把内存里经手过的会话挤出目录", async () => {
		// 磁盘上一个都没有：0 消息会话还没会话文件，重拉必然拿不到它
		piMock.listAllSessions.mockResolvedValue([]);
		useSessionsStore.setState({ sessions: [freshMeta("new-1", "/p")] });
		await useProjectsStore.getState().load();
		expect(ids()).toEqual(["new-1"]);
	});

	it("被内存策略卸载后目录仍有它：左栏行不消失", () => {
		// 1) 新建出来的会话进内存 → 写穿目录（此刻磁盘快照里没有它）
		useSessionsStore.setState({ sessions: [freshMeta("new-1", "/p")] });
		// 2) GC 卸载 = 从内存移除（closeSession 的清理路径）
		useSessionsStore.setState({ sessions: [] });
		// 3) 左栏派生照旧能渲染这一行（Sidebar 走的就是同一条装配路径）
		const nav = deriveSidebarNavigation({
			history: useProjectsStore.getState().allSessions,
			memory: [],
			addedProjects: [],
			search: "",
			activeCwd: null,
			pinnedSessions: ["new-1"],
			pinnedProjects: [],
			expandedGroups: ["/p"],
			expandedGroupsTouched: true,
		});
		const rows = nav.projects.flatMap((project) => project.sessions.map((row) => row.session.sessionId));
		expect(rows).toEqual(["new-1"]);
	});

	it("自动命名写回目录后，GC 卸载不会退回项目目录名", () => {
		const unnamed = { ...freshMeta("new-1", "/work/percho"), name: undefined };
		useSessionsStore.setState({ sessions: [unnamed] });

		// 对应 session_info_changed 的目录投影同步。
		useProjectsStore.getState().applySessionName("new-1", "用户第一条消息");
		useSessionsStore.setState({ sessions: [] });

		expect(useProjectsStore.getState().allSessions[0]?.name).toBe("用户第一条消息");
	});
});

describe("projects.load latest-wins（spec D6）", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		piMock.listAllSessions.mockReset();
		useProjectsStore.setState({
			allSessions: [],
			selectedCwd: null,
			search: "",
			loading: false,
			loaded: false,
		});
	});

	it("load A 后 load B，B 先返回、A 后返回：最终 store 是 B，loading=false", async () => {
		const a = deferred<SessionMeta[]>();
		const b = deferred<SessionMeta[]>();
		piMock.listAllSessions.mockImplementationOnce(() => a.promise).mockImplementationOnce(() => b.promise);

		const loadA = useProjectsStore.getState().load();
		const loadB = useProjectsStore.getState().load();
		b.resolve([session("/p", 200)]);
		await loadB;
		a.resolve([session("/p", 100)]);
		await loadA;

		expect(ids()).toEqual(["/p-200"]);
		expect(useProjectsStore.getState().loading).toBe(false);
		expect(useProjectsStore.getState().loaded).toBe(true);
	});

	it("旧请求失败：不得覆盖新请求成功结果", async () => {
		const a = deferred<SessionMeta[]>();
		const b = deferred<SessionMeta[]>();
		piMock.listAllSessions.mockImplementationOnce(() => a.promise).mockImplementationOnce(() => b.promise);

		const loadA = useProjectsStore.getState().load();
		const loadB = useProjectsStore.getState().load();
		b.resolve([session("/p", 300)]);
		await loadB;
		a.reject(new Error("boom"));
		await loadA;

		expect(ids()).toEqual(["/p-300"]);
		expect(useProjectsStore.getState().loading).toBe(false);
	});

	it("旧请求先失败：不得提前把 loading 置 false（新请求仍在途）", async () => {
		const a = deferred<SessionMeta[]>();
		const b = deferred<SessionMeta[]>();
		piMock.listAllSessions.mockImplementationOnce(() => a.promise).mockImplementationOnce(() => b.promise);

		const loadA = useProjectsStore.getState().load();
		const loadB = useProjectsStore.getState().load();
		a.reject(new Error("boom"));
		await loadA;
		expect(useProjectsStore.getState().loading).toBe(true);

		b.resolve([session("/p", 400)]);
		await loadB;
		expect(ids()).toEqual(["/p-400"]);
		expect(useProjectsStore.getState().loading).toBe(false);
	});
});
