import type { SessionMeta } from "@percho/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** window.pi 的 mock：sessions/projects store 经 getPi() 访问，测试环境无 preload 注入 */
const piMock = vi.hoisted(() => ({
	openSession: vi.fn(),
	deleteSession: vi.fn(() => Promise.resolve()),
	closeSession: vi.fn(() => Promise.resolve({ closed: true })),
	getSessionMessages: vi.fn(() => Promise.resolve([])),
	markSessionHistoryReady: vi.fn(() => Promise.resolve()),
	getFollowUpMessages: vi.fn(() => Promise.resolve([])),
	getTodos: vi.fn(() => Promise.resolve([])),
	getPermissionMode: vi.fn(() => Promise.resolve("default" as const)),
	setPermissionMode: vi.fn(() => Promise.resolve()),
	saveUiState: vi.fn(() => Promise.resolve()),
	loadUiState: vi.fn(() => Promise.resolve(undefined)),
}));
vi.mock("../api", () => ({ getPi: () => piMock }));

import { useProjectsStore } from "./projects";
import { clearSessionHistory } from "./session-history";
import { useSessionWorkspaceStore } from "./session-workspace";
import { useSessionsStore } from "./sessions";
import { useSubagentReturnStore } from "./subagent-return";
import { useTranscriptStore } from "./transcript";

/**
 * spec D4 · 子代理检视页的返回父会话：
 * - 打开路径：点子代理卡 → 统一打开动作 → **只在成功且仍是最新导航意图**时记关系；失败/迟到不挂假记录；
 * - 返回路径：父仍加载 → switchSession（不加成员、不重建条目）；父被 GC 卸载 → 按 parentFile 重开且不动成员顺序；
 * - 清理：只有**删除**清关系（GC 卸载不清，否则箭头就没了）；直接从历史进入子文件不产生关系。
 */

const childFile = "/tmp/sub-1.jsonl";
const parent = realMeta("parent", "/proj");
const child = realMeta("sub-1", "/proj", childFile);
const other = realMeta("other", "/proj");

function realMeta(sessionId: string, cwd: string, sessionFile = `/tmp/${sessionId}.jsonl`): SessionMeta {
	return { sessionId, cwd, sessionFile, active: true, messageCount: 0, createdAt: 1 };
}

const relations = () => useSubagentReturnStore.getState().relations;
const active = () => useSessionsStore.getState().activeSessionId;
const members = () => useSessionWorkspaceStore.getState().members.map((m) => m.sessionId);

beforeEach(() => {
	vi.clearAllMocks();
	piMock.openSession.mockReset();
	for (const id of Object.keys(useTranscriptStore.getState().bySession)) clearSessionHistory(id);
	useSessionsStore.setState({
		sessions: [],
		activeSessionId: null,
		cwd: null,
		newSessionDraft: null,
		permissionModes: {},
	});
	useSessionWorkspaceStore.setState({ members: [], activeFile: null, epoch: 0 });
	useSubagentReturnStore.setState({ relations: {} });
});

function openParentAsActive(): void {
	useSessionsStore.setState({ sessions: [parent], activeSessionId: "parent", cwd: "/proj" });
}

describe("打开子代理检视页：建立返回关系", () => {
	it("点子代理卡进入子会话：记录父目标；父会话自身没有关系（箭头只在子页）", async () => {
		openParentAsActive();
		piMock.openSession.mockResolvedValue(child);

		const result = await useSessionsStore.getState().openSubagentSession(childFile);

		expect(result.ok).toBe(true);
		expect(active()).toBe("sub-1");
		expect(relations()).toEqual({
			"sub-1": { parentSessionId: "parent", parentFile: parent.sessionFile },
		});
		expect(relations().parent).toBeUndefined();
	});

	it("直接从历史打开子文件（无已知父关系）：不显示箭头", async () => {
		openParentAsActive();
		piMock.openSession.mockResolvedValue(child);

		await useSessionsStore.getState().openFromHistory(childFile);

		expect(active()).toBe("sub-1");
		expect(relations()).toEqual({});
	});

	it("打开失败（后端抛错）：不挂假记录，焦点不变", async () => {
		openParentAsActive();
		piMock.openSession.mockRejectedValue(new Error("session file not found"));

		const result = await useSessionsStore.getState().openSubagentSession(childFile);

		expect(result.ok).toBe(false);
		expect(relations()).toEqual({});
		expect(active()).toBe("parent");
	});

	it("等待打开期间用户又导航（更新的意图）：迟到提交不写关系", async () => {
		openParentAsActive();
		useSessionsStore.setState({ sessions: [parent, other] });
		let release: () => void = () => {};
		piMock.openSession.mockImplementation(
			() =>
				new Promise<SessionMeta>((resolve) => {
					release = () => resolve(child);
				}),
		);

		const pending = useSessionsStore.getState().openSubagentSession(childFile);
		useSessionsStore.getState().switchSession("other"); // 用户在等待期间切走了
		release();
		const result = await pending;

		expect(result).toMatchObject({ ok: true, latest: false });
		expect(relations()).toEqual({}); // 没有幽灵箭头
		expect(active()).toBe("other");
	});

	it("提交前的导航令牌守卫：已判定 latest:true、active childId 也没变，但提交前又导航 ⇒ 不写关系", async () => {
		openParentAsActive();
		piMock.openSession.mockResolvedValue(child);
		// 在「子会话刚被激活」的同步时刻插入一次新导航（同一个 childId ⇒ 只比对 activeSessionId 的守卫会放过它）
		let interfered = 0;
		const unsubscribe = useSessionsStore.subscribe((state, prev) => {
			if (interfered === 0 && state.activeSessionId === "sub-1" && prev.activeSessionId !== "sub-1") {
				interfered += 1;
				useSessionsStore.getState().switchSession("sub-1");
			}
		});

		const result = await useSessionsStore.getState().openSubagentSession(childFile);
		unsubscribe();

		expect(interfered).toBe(1); // 反例确实编排进了「latest 已判定、关系尚未提交」的窗口
		expect(result).toMatchObject({ ok: true, latest: true }); // latest 在干扰之前就已为 true
		expect(active()).toBe("sub-1"); // 活动子会话 id 仍然相同（只比 id 的守卫会放过这次提交）
		expect(relations()).toEqual({}); // 只有提交前的令牌守卫能拦住它
	});

	it("同一子会话被两个父会话先后打开：最新入口决定父关系", async () => {
		openParentAsActive();
		piMock.openSession.mockResolvedValue(child);
		await useSessionsStore.getState().openSubagentSession(childFile);
		expect(relations()["sub-1"]?.parentSessionId).toBe("parent");

		// 从另一个父会话再点同一个子代理卡
		useSessionsStore.setState({ sessions: [parent, other] });
		useSessionsStore.getState().switchSession("other");
		await useSessionsStore.getState().openSubagentSession(childFile);

		expect(relations()["sub-1"]).toEqual({ parentSessionId: "other", parentFile: other.sessionFile });
	});
});

describe("返回父会话", () => {
	it("父仍加载：切回父会话，不新增工作区成员、不重建会话条目（实时 transcript 保持）", async () => {
		openParentAsActive();
		const differentCwdChild = { ...child, cwd: "/child/loaded-parent-return" };
		piMock.openSession.mockResolvedValue(differentCwdChild);
		await useSessionsStore.getState().openSubagentSession(childFile);
		useSessionWorkspaceStore.getState().addMember({ file: parent.sessionFile, sessionId: "parent" });
		const membersBefore = members();
		const parentEntryBefore = useSessionsStore.getState().sessions.find((s) => s.sessionId === "parent");
		const openCallsBefore = piMock.openSession.mock.calls.length;
		expect(useSessionsStore.getState().cwd).toBe(differentCwdChild.cwd);
		expect(useSessionsStore.getState().cwd).not.toBe(parent.cwd);

		const ok = await useSessionsStore.getState().returnToParent("sub-1");

		expect(ok).toBe(true);
		expect(active()).toBe("parent");
		expect(members()).toEqual(membersBefore);
		expect(useSessionsStore.getState().sessions.find((s) => s.sessionId === "parent")).toBe(
			parentEntryBefore,
		);
		expect(piMock.openSession.mock.calls.length).toBe(openCallsBefore); // 没有重新打开
		expect(useSessionsStore.getState().cwd).toBe(parent.cwd);
	});

	it("父已被 GC 卸载：按 parentFile 重开，不新增成员、成员顺序不变", async () => {
		openParentAsActive();
		const differentCwdChild = { ...child, cwd: "/child/gc-parent-return" };
		piMock.openSession.mockResolvedValue(differentCwdChild);
		await useSessionsStore.getState().openSubagentSession(childFile);
		useSessionWorkspaceStore.getState().addMember({ file: parent.sessionFile, sessionId: "parent" });
		useSessionWorkspaceStore.getState().addMember({ file: child.sessionFile, sessionId: "sub-1" });
		const membersBefore = members();
		await useSessionsStore.getState().closeSession("parent", "gc"); // 内存策略卸载父会话
		expect(useSessionsStore.getState().sessions.some((s) => s.sessionId === "parent")).toBe(false);
		piMock.openSession.mockResolvedValue(parent);
		expect(useSessionsStore.getState().cwd).toBe(differentCwdChild.cwd);
		expect(useSessionsStore.getState().cwd).not.toBe(parent.cwd);

		const ok = await useSessionsStore.getState().returnToParent("sub-1");

		expect(ok).toBe(true);
		expect(piMock.openSession).toHaveBeenCalledWith({ filePath: parent.sessionFile });
		expect(active()).toBe("parent");
		expect(members()).toEqual(membersBefore); // 没有新增/重排成员
		expect(useSessionsStore.getState().cwd).toBe(parent.cwd);
	});

	it("父会话文件已丢失（重开失败）：留在子页并如实返回失败", async () => {
		openParentAsActive();
		piMock.openSession.mockResolvedValue(child);
		await useSessionsStore.getState().openSubagentSession(childFile);
		await useSessionsStore.getState().closeSession("parent", "gc");
		piMock.openSession.mockRejectedValue(new Error("session file not found")); // 文件被外部删除/损坏

		const ok = await useSessionsStore.getState().returnToParent("sub-1");

		expect(ok).toBe(false);
		expect(active()).toBe("sub-1"); // 留在子页，不做猜测性跳转
	});

	it("没有关系的会话：返回动作是 no-op", async () => {
		openParentAsActive();
		expect(await useSessionsStore.getState().returnToParent("parent")).toBe(false);
		expect(active()).toBe("parent");
	});
});

describe("关系清理：只有删除会清（GC 卸载不清）", () => {
	it("父会话被 GC 卸载后关系仍在（返回箭头不消失）", async () => {
		openParentAsActive();
		piMock.openSession.mockResolvedValue(child);
		await useSessionsStore.getState().openSubagentSession(childFile);

		await useSessionsStore.getState().closeSession("parent", "gc");

		expect(relations()["sub-1"]).toBeDefined();
	});

	it("父会话被删除：以它为父的关系一并清掉", async () => {
		useSubagentReturnStore.setState({
			relations: {
				"sub-1": { parentSessionId: "parent", parentFile: parent.sessionFile },
				"sub-2": { parentSessionId: "parent", parentFile: parent.sessionFile },
				"sub-3": { parentSessionId: "other", parentFile: other.sessionFile },
			},
		});
		useSessionsStore.setState({ sessions: [parent], activeSessionId: "sub-1", cwd: "/proj" });
		useSessionsStore.setState({ sessions: [parent, child, other], activeSessionId: "sub-1" });

		await useProjectsStore.getState().deleteSession(parent);

		expect(relations()).toEqual({ "sub-3": { parentSessionId: "other", parentFile: other.sessionFile } });
	});

	it("子会话被删除：它自己的关系清掉（不留幽灵箭头）", async () => {
		useSubagentReturnStore.setState({
			relations: { "sub-1": { parentSessionId: "parent", parentFile: parent.sessionFile } },
		});
		useSessionsStore.setState({ sessions: [parent, child], activeSessionId: "parent", cwd: "/proj" });

		await useProjectsStore.getState().deleteSession(child);

		expect(relations()).toEqual({});
	});
});
