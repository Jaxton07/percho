import type { SessionMeta } from "@percho/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** window.pi 的 mock：store 的 load 经 getPi() 访问（测试环境无 preload 注入） */
const piMock = vi.hoisted(() => ({
	listAllSessions: vi.fn(),
	getDailyDir: vi.fn(() => Promise.resolve(null)),
}));
vi.mock("../api", () => ({ getPi: () => piMock }));

import { setDailyDirForTest } from "../lib/daily";
import { deriveProjects, useProjectsStore } from "./projects";

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
