import type { SessionMeta } from "@percho/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** window.pi 的 mock：恢复链经 getPi() 访问，测试环境无 preload 注入 */
const piMock = vi.hoisted(() => ({
	loadUiState: vi.fn(),
	listAllSessions: vi.fn(),
	getDailyDir: vi.fn(() => Promise.resolve(null)),
	openSession: vi.fn(),
	getSessionMessages: vi.fn(() => Promise.resolve([])),
	getFollowUpMessages: vi.fn(() => Promise.resolve([])),
	getTodos: vi.fn(() => Promise.resolve([])),
	getPermissionMode: vi.fn(() => Promise.resolve("default" as const)),
	saveUiState: vi.fn(() => Promise.resolve()),
	closeSession: vi.fn(() => Promise.resolve({ closed: true })),
}));
vi.mock("../api", () => ({ getPi: () => piMock }));

import { useProjectsStore } from "./projects";
import { useSessionWorkspaceStore } from "./session-workspace";
import { restoreSessionWorkspace } from "./session-workspace-restore";
import { useSessionsStore } from "./sessions";
import { useUiPreferencesStore } from "./ui-preferences";

const FILE_A = "/sessions/a.jsonl";
const FILE_B = "/sessions/b.jsonl";
const FILE_GONE = "/sessions/gone.jsonl";

function meta(sessionId: string, sessionFile: string, extra: Partial<SessionMeta> = {}): SessionMeta {
	return {
		sessionId,
		sessionFile,
		cwd: "/p",
		name: sessionId,
		active: false,
		messageCount: 2,
		createdAt: 1,
		modifiedAt: 1,
		...extra,
	};
}

function resetStores(): void {
	// 顺序有讲究：先清工作区再动 sessions —— sessions 的 activeSessionId 订阅会按成员表重算 activeFile，
	// 反过来的话会在每次复位时白写一次 ui-state（测试里表现成调用数谜之 +1）
	useSessionWorkspaceStore.setState({ members: [], activeFile: null, epoch: 0 });
	useSessionsStore.setState({ sessions: [], activeSessionId: null, cwd: null, lastUsedAt: {} });
	useProjectsStore.setState({
		allSessions: [],
		selectedCwd: null,
		search: "",
		loading: false,
		loaded: false,
	});
	useUiPreferencesStore.setState({ barSessionsVisible: true, sessionRailEnabled: false });
}

beforeEach(async () => {
	// 先让上一条用例遗留的合并式持久化 flush 跑完（它是异步串行的），否则它会计入本用例的调用数
	for (let i = 0; i < 5; i++) await Promise.resolve();
	vi.clearAllMocks();
	piMock.listAllSessions.mockResolvedValue([]);
	piMock.loadUiState.mockResolvedValue({});
	// 默认打开失败：测试必须**显式**声明「这次应该打开成功」——否则本不该发生的 open 会被静默放过
	piMock.openSession.mockRejectedValue(new Error("no such session"));
	resetStores();
});

describe("restoreSessionWorkspace（冷启动恢复）", () => {
	it("只按需加载 activeFile 一条：其它成员只进工作区，不调 openSession", async () => {
		piMock.loadUiState.mockResolvedValue({
			sessionWorkspace: { files: [FILE_A, FILE_B], activeFile: FILE_B },
		});
		piMock.listAllSessions.mockResolvedValue([meta("a", FILE_A), meta("b", FILE_B)]);
		piMock.openSession.mockResolvedValue(meta("b", FILE_B));

		await restoreSessionWorkspace();

		expect(piMock.openSession).toHaveBeenCalledTimes(1);
		expect(piMock.openSession).toHaveBeenCalledWith({ filePath: FILE_B });
		expect(useSessionsStore.getState().activeSessionId).toBe("b");
		// 成员按快照顺序恢复（顺序 = 上次的工作区顺序，不是目录排序）
		expect(useSessionWorkspaceStore.getState().members.map((m) => m.file)).toEqual([FILE_A, FILE_B]);
		expect(useSessionWorkspaceStore.getState().activeFile).toBe(FILE_B);
	});

	it("目录对账失败（IPC 抛错）：不裁剪、不写盘、不打开会话", async () => {
		piMock.loadUiState.mockResolvedValue({
			sessionWorkspace: { files: [FILE_A, FILE_B], activeFile: FILE_B },
		});
		piMock.listAllSessions.mockRejectedValue(new Error("目录不可用"));

		await restoreSessionWorkspace();

		expect(useSessionWorkspaceStore.getState().members).toEqual([]);
		expect(piMock.openSession).not.toHaveBeenCalled();
		// 关键：宁可这次不恢复，也不能把「读不到目录」当成「成员都失效了」写回文件
		expect(piMock.saveUiState).not.toHaveBeenCalled();
	});

	it("失效项裁剪并落盘修复快照：已删成员、0 消息会话（只有计划路径）都剔除", async () => {
		const FILE_EMPTY = "/sessions/empty.jsonl";
		piMock.loadUiState.mockResolvedValue({
			sessionWorkspace: { files: [FILE_GONE, FILE_A, FILE_EMPTY], activeFile: FILE_A },
		});
		piMock.listAllSessions.mockResolvedValue([meta("a", FILE_A)]);
		piMock.openSession.mockResolvedValue(meta("a", FILE_A));

		await restoreSessionWorkspace();

		expect(useSessionWorkspaceStore.getState().members.map((m) => m.file)).toEqual([FILE_A]);
		await vi.waitFor(() =>
			expect(piMock.saveUiState).toHaveBeenLastCalledWith({
				state: { sessionWorkspace: { files: [FILE_A], activeFile: FILE_A } },
			}),
		);
	});

	it("activeFile 指向失效项：成员照旧恢复，但不打开任何会话（停在新会话页）", async () => {
		piMock.loadUiState.mockResolvedValue({
			sessionWorkspace: { files: [FILE_A, FILE_GONE], activeFile: FILE_GONE },
		});
		piMock.listAllSessions.mockResolvedValue([meta("a", FILE_A)]);

		await restoreSessionWorkspace();

		expect(useSessionWorkspaceStore.getState().members.map((m) => m.file)).toEqual([FILE_A]);
		expect(useSessionWorkspaceStore.getState().activeFile).toBeNull();
		expect(piMock.openSession).not.toHaveBeenCalled();
		expect(useSessionsStore.getState().activeSessionId).toBeNull();
	});

	it("快照为空：不进目录对账也不打开会话（老用户升级路径）", async () => {
		piMock.loadUiState.mockResolvedValue({ pinnedSessions: ["a", "b"] });

		await restoreSessionWorkspace();

		expect(piMock.listAllSessions).not.toHaveBeenCalled();
		expect(piMock.openSession).not.toHaveBeenCalled();
		expect(useSessionWorkspaceStore.getState().members).toEqual([]);
	});

	it("两个显示入口都关：不恢复（工作区语义上就是空的）", async () => {
		useUiPreferencesStore.setState({ barSessionsVisible: false, sessionRailEnabled: false });
		piMock.loadUiState.mockResolvedValue({
			sessionWorkspace: { files: [FILE_A], activeFile: FILE_A },
		});

		await restoreSessionWorkspace();

		expect(piMock.loadUiState).not.toHaveBeenCalled();
		expect(piMock.listAllSessions).not.toHaveBeenCalled();
		expect(useSessionWorkspaceStore.getState().members).toEqual([]);
	});

	it("用户已经自己导航过（真实导航领号）：恢复成员但不抢焦点", async () => {
		piMock.loadUiState.mockResolvedValue({
			sessionWorkspace: { files: [FILE_A, FILE_B], activeFile: FILE_B },
		});
		// 目录还在读时，用户真正点了一个会话（switchSession = 一次导航，会领号）
		piMock.listAllSessions.mockImplementation(() => {
			useSessionsStore.setState({ sessions: [meta("x", "/sessions/x.jsonl")] });
			useSessionsStore.getState().switchSession("x");
			return Promise.resolve([meta("a", FILE_A), meta("b", FILE_B)]);
		});

		await restoreSessionWorkspace();

		expect(piMock.openSession).not.toHaveBeenCalled();
		expect(useSessionsStore.getState().activeSessionId).toBe("x");
		expect(useSessionWorkspaceStore.getState().members.map((m) => m.file)).toEqual([FILE_A, FILE_B]);
	});

	it("用户在目录在途时回新会话页（draft，activeSessionId 仍为 null）：恢复不得把它抢回来", async () => {
		piMock.loadUiState.mockResolvedValue({
			sessionWorkspace: { files: [FILE_A], activeFile: FILE_A },
		});
		// 真实导航：点「＋」/项目行 —— activeSessionId 保持 null，但导航号必须前进
		piMock.listAllSessions.mockImplementation(() => {
			useSessionsStore.getState().activateNewSessionDraft();
			return Promise.resolve([meta("a", FILE_A)]);
		});

		await restoreSessionWorkspace();

		expect(useSessionsStore.getState().activeSessionId).toBeNull();
		expect(piMock.openSession).not.toHaveBeenCalled();
		expect(useSessionWorkspaceStore.getState().members.map((m) => m.file)).toEqual([FILE_A]);
		// 成员保留，但**指针不落盘**：否则下次重启又会自动进旧会话，抢掉用户当下停的新会话页
		expect(useSessionWorkspaceStore.getState().activeFile).toBeNull();
		await vi.waitFor(() =>
			expect(piMock.saveUiState).toHaveBeenLastCalledWith({
				state: { sessionWorkspace: { files: [FILE_A], activeFile: null } },
			}),
		);
	});

	it("目录在途时用户自己打开了 C：C 不被快照覆盖（并入而非替换），也保留用户的当前指针", async () => {
		const FILE_C = "/sessions/c.jsonl";
		piMock.loadUiState.mockResolvedValue({
			sessionWorkspace: { files: [FILE_A, FILE_B], activeFile: FILE_B },
		});
		// 用户在恢复等待期间从左栏打开 C（真实入口 = projects.openSession → addMember）
		piMock.listAllSessions.mockImplementation(() => {
			useSessionWorkspaceStore.getState().addMember({ file: FILE_C, sessionId: "c" });
			return Promise.resolve([meta("a", FILE_A), meta("b", FILE_B), meta("c", FILE_C)]);
		});

		await restoreSessionWorkspace();

		// 已存工作区 + 新开的 C 都在（快照在前、用户新开的在后），当前指针留在 C，且不应发生任何导航
		expect(useSessionWorkspaceStore.getState().members.map((m) => m.file)).toEqual([FILE_A, FILE_B, FILE_C]);
		expect(useSessionWorkspaceStore.getState().activeFile).toBe(FILE_C);
		expect(piMock.openSession).not.toHaveBeenCalled();
		expect(useSessionsStore.getState().activeSessionId).toBeNull();
		await vi.waitFor(() =>
			expect(piMock.saveUiState).toHaveBeenLastCalledWith({
				state: { sessionWorkspace: { files: [FILE_A, FILE_B, FILE_C], activeFile: FILE_C } },
			}),
		);
	});

	it("恢复自己读目录（不依赖 projects.load 的返回值）：读到了就落 store", async () => {
		piMock.loadUiState.mockResolvedValue({
			sessionWorkspace: { files: [FILE_A], activeFile: FILE_A },
		});
		piMock.listAllSessions.mockResolvedValue([meta("a", FILE_A)]);
		piMock.openSession.mockResolvedValue(meta("a", FILE_A));

		await restoreSessionWorkspace();

		expect(piMock.listAllSessions).toHaveBeenCalledTimes(1);
		// 目录投影落到 store（未加载成员的胶囊靠它拿 meta）
		expect(useProjectsStore.getState().allSessions.map((s) => s.sessionId)).toEqual(["a"]);
		expect(useProjectsStore.getState().loaded).toBe(true);
	});

	it("恢复途中用户关掉开关清空工作区：迟到的恢复不得把成员复活", async () => {
		piMock.loadUiState.mockResolvedValue({
			sessionWorkspace: { files: [FILE_A, FILE_B], activeFile: FILE_B },
		});
		piMock.listAllSessions.mockImplementation(() => {
			// 用户在恢复在途时关掉两处开关 → 工作区清空 + 代次自增
			useUiPreferencesStore.setState({ barSessionsVisible: false, sessionRailEnabled: false });
			return Promise.resolve([meta("a", FILE_A), meta("b", FILE_B)]);
		});

		await restoreSessionWorkspace();

		expect(useSessionWorkspaceStore.getState().members).toEqual([]);
		expect(piMock.openSession).not.toHaveBeenCalled();
	});

	it("本次进程已经恢复过（或用户已开过会话）：幂等返回，不重放", async () => {
		useSessionWorkspaceStore.setState({ members: [{ file: FILE_A, sessionId: "a" }] });

		await restoreSessionWorkspace();

		expect(piMock.loadUiState).not.toHaveBeenCalled();
	});

	it("恢复打开失败（文件已不在磁盘）：不 panic、不改工作区，交由按需打开报错", async () => {
		piMock.loadUiState.mockResolvedValue({
			sessionWorkspace: { files: [FILE_A], activeFile: FILE_A },
		});
		piMock.listAllSessions.mockResolvedValue([meta("a", FILE_A)]);
		piMock.openSession.mockRejectedValue(new Error("ENOENT"));

		await restoreSessionWorkspace();

		expect(useSessionWorkspaceStore.getState().members.map((m) => m.file)).toEqual([FILE_A]);
		expect(useSessionsStore.getState().activeSessionId).toBeNull();
	});
});
